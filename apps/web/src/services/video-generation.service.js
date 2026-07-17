const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { cleanText, getAdditionalCommonPrompt, slugify } = require('../shared/text');
const { providerOutput } = require('../providers/result');

const DEFAULT_MOTION_PROMPT = [
  'Show clear continuous subject movement and follow-through; never a frozen hold.',
].join(' ');

const INTENSITY_MOTION_PROMPTS = Object.freeze({
  subtle: 'Small continuous movement and gentle follow-through.',
  medium: DEFAULT_MOTION_PROMPT,
  high: 'Strong continuous action and pronounced follow-through; never a frozen hold.',
});

const STYLE_MOTION_PROMPTS = Object.freeze({
  'basic-cartoon': 'Exaggerated snap, recoil, comic timing.',
  'cinematic-reality': 'Grounded weight, natural momentum, realistic follow-through.',
  'dark-gothic': 'Restrained movement, heavy drift, ominous atmosphere.',
  'indie-youtuber': 'Lively gestures, casual energy, clean motion.',
  'vox-style': 'Crisp cutout slides, simple layers, light parallax.',
});

const VIDEO_PROMPT_WORD_BUDGET = Object.freeze({
  action: 24,
  motion: 18,
  visual: 28,
  style: 16,
  additionalStyle: 5,
});

function clipWords(value, limit) {
  return cleanText(value, 20_000).split(/\s+/).filter(Boolean).slice(0, limit).join(' ');
}

function buildVideoPrompt(input, style, configuredMotionPrompt = '') {
  const common = getAdditionalCommonPrompt(style.promptText, input.commonPromptText);
  const intensityMotion = INTENSITY_MOTION_PROMPTS[input.motionIntensity] || INTENSITY_MOTION_PROMPTS.medium;
  const styleMotion = STYLE_MOTION_PROMPTS[style.id] || 'Clear readable motion.';
  const motion = cleanText(`${input.motionPrompt || configuredMotionPrompt || intensityMotion} ${styleMotion}`, 4_000);
  return [
    input.sceneBeat ? `Story action: ${clipWords(input.sceneBeat, VIDEO_PROMPT_WORD_BUDGET.action)}` : '',
    `Motion direction: ${clipWords(motion, VIDEO_PROMPT_WORD_BUDGET.motion)}`,
    input.scenePrompt ? `Scene visual prompt: ${clipWords(input.scenePrompt, VIDEO_PROMPT_WORD_BUDGET.visual)}` : '',
    `Style baseline: ${clipWords(style.promptText, VIDEO_PROMPT_WORD_BUDGET.style)}`,
    common ? `Additional style direction: ${clipWords(common, VIDEO_PROMPT_WORD_BUDGET.additionalStyle)}` : '',
  ].filter(Boolean).join('\n\n');
}

function createVideoGenerationService({ config, provider, projectStore, styles }) {
  async function resolve(publicPath, ownerId) {
    const match = String(publicPath || '').match(/^\/projects\/([^/]+)\/assets\/images\/([^/]+)$/);
    if (!match) return null;
    const projectId = decodeURIComponent(match[1]);
    const file = decodeURIComponent(match[2]);
    if (file !== path.basename(file)) return null;
    if (projectStore.findAsset) return (await projectStore.findAsset(projectId, 'images', file, { ownerId })).sourcePath;
    await projectStore.read(projectId, { ownerId });
    return path.join(projectStore.assetDir(projectId, 'images'), file);
  }

  return {
    verify: () => provider.verify(),
    async generate(input, { ownerId, userId, signal, jobId } = {}) {
      const source = await resolve(input.imagePath, ownerId);
      if (!source || !fs.existsSync(source)) {
        throw new AppError('INVALID_PATH', 'A valid generated reference image is required', { status: 400 });
      }
      const style = styles.find(input.styleId);
      if (!style) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 400 });

      const prompt = buildVideoPrompt(input, style, config.env.VIDEO_MOTION_PROMPT);
      const lease = await projectStore.acquireLease(input.projectId, { ownerId, userId });
      await provider.verify();
      fs.mkdirSync(config.paths.videos, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
      const staged = path.join(config.paths.videos, file);
      try {
        providerOutput(await provider.generate({
          imagePath: source,
          prompt,
          motionIntensity: input.motionIntensity,
          outputPath: staged,
        }));
        const asset = await projectStore.commitAsset(lease, 'videos', staged, { signal, mimeType: 'video/mp4' });
        const version = { path: asset.path, prompt, sourceImagePath: input.imagePath, provider: config.videoProvider, createdAt: new Date().toISOString() };
        let scene, project;
        try {
          ({ scene, project } = await projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'video', version, jobId }));
        } catch (error) {
          if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true });
          throw error;
        }
        return {
          video: {
            fileName: file,
            path: asset.path,
            sourceImagePath: input.imagePath,
            prompt,
            mimeType: 'video/mp4',
            provider: config.videoProvider,
          },
          scene,
          revision: project.revision,
        };
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
}

module.exports = { DEFAULT_MOTION_PROMPT, INTENSITY_MOTION_PROMPTS, STYLE_MOTION_PROMPTS, VIDEO_PROMPT_WORD_BUDGET, buildVideoPrompt, createVideoGenerationService };
