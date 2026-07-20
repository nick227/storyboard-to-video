const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { cleanText, getAdditionalCommonPrompt, slugify } = require('../shared/text');
const { providerOutput } = require('../providers/result');
const { createGenerationManifest } = require('../shared/generation-manifest');
const { imageShot } = require('../shared/scene-shots');
const { videoProviderCapabilities } = require('../shared/video-provider-capabilities');

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
  'money-wolf': 'Pop Art modern graphical realism, popular references.', 
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
    if (!publicPath) return null;
    const match = String(publicPath).match(/^\/projects\/([^/]+)\/assets\/[^/]+\/[^/]+$/);
    if (!match) return null;
    const projectId = decodeURIComponent(match[1]);
    const asset = await projectStore.resolveAsset(projectId, publicPath, { ownerId });
    return asset?.sourcePath || null;
  }

  function fileHash(sourcePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  }

  return {
    verify: async () => ({ ...(await provider.verify()), capabilities: provider.getCapabilities ? provider.getCapabilities() : videoProviderCapabilities(config.videoProvider === 'stub' ? 'stub' : 'ltx') }),
    async generate(input, { ownerId, userId, signal, jobId } = {}) {
      const lease = await projectStore.acquireLease(input.projectId, { ownerId, userId });
      const project = await projectStore.verifyLease(lease, signal);
      const sceneBeforeGeneration = project.scenes?.find((scene) => scene.id === input.sceneId);
      if (!sceneBeforeGeneration) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      const shot = imageShot(sceneBeforeGeneration);
      const activeImage = shot.versions?.[shot.activeVersionIndex] || null;
      const startFramePath = shot.startFrame || activeImage?.path || input.imagePath || null;
      const endFramePath = shot.endFrame || null;
      const startSource = await resolve(startFramePath, ownerId);
      if (!startSource || !fs.existsSync(startSource)) {
        throw new AppError('INVALID_PATH', 'A valid generated reference image is required', { status: 400 });
      }
      const endSource = endFramePath ? await resolve(endFramePath, ownerId) : null;
      if (endFramePath && (!endSource || !fs.existsSync(endSource))) throw new AppError('INVALID_END_FRAME', 'The selected end frame is unavailable', { status: 400 });
      const capabilities = provider.getCapabilities ? provider.getCapabilities() : videoProviderCapabilities(config.videoProvider === 'stub' ? 'stub' : 'ltx');
      const style = styles.find(input.styleId);
      if (!style) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 400 });

      const prompt = buildVideoPrompt(input, style, config.env.VIDEO_MOTION_PROMPT);
      await provider.verify();
      fs.mkdirSync(config.paths.videos, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
      const staged = path.join(config.paths.videos, file);
      try {
        const providerResponse = await provider.generate({
          startFramePath: startSource,
          ...(capabilities.supportsEndFrame && endSource ? { endFramePath: endSource } : {}),
          prompt,
          motionIntensity: input.motionIntensity,
          outputPath: staged,
        });
        providerOutput(providerResponse);
        const metadata = providerResponse && Object.hasOwn(providerResponse, 'output') ? providerResponse : {};
        const asset = await projectStore.commitAsset(lease, 'videos', staged, { signal, mimeType: 'video/mp4' });
        const createdAt = new Date().toISOString();
        const manifest = createGenerationManifest({
          modality: 'video',
          createdAt,
          inputs: {
            operation: 'video.generate',
            prompt: { composed: prompt, scene: input.scenePrompt || '', beat: input.sceneBeat || '', style: style.promptText, common: getAdditionalCommonPrompt(style.promptText, input.commonPromptText), motion: input.motionPrompt || '' },
            style: { id: style.id },
            provider: { name: metadata.provider || config.videoProvider, model: metadata.model || null },
            settings: { ...(metadata.settings || {}), motionIntensity: input.motionIntensity || 'medium' },
            sourceAssets: [
              { role: 'start_frame', path: startFramePath, sha256: fileHash(startSource), consumed: capabilities.supportsStartFrame },
              ...(endFramePath ? [{ role: 'end_frame', path: endFramePath, sha256: fileHash(endSource), consumed: capabilities.supportsEndFrame }] : []),
            ],
          },
          result: { providerRequestId: metadata.providerRequestId || null, measurementStatus: metadata.measurementStatus || 'unavailable', mimeType: 'video/mp4' },
        });
        const version = { path: asset.path, prompt, sourceImagePath: startFramePath, startFramePath, endFramePath, provider: config.videoProvider, manifest, manifestHash: manifest.manifestHash, createdAt };
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
            sourceImagePath: startFramePath,
            startFramePath,
            endFramePath,
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
