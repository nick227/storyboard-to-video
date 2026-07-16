const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { cleanText, getAdditionalCommonPrompt, slugify } = require('../shared/text');

const DEFAULT_MOTION_PROMPT = [
  'Show clear continuous subject movement and follow-through; never a frozen hold.',
].join(' ');

function clipWords(value, limit) {
  return cleanText(value, 20_000).split(/\s+/).filter(Boolean).slice(0, limit).join(' ');
}

function buildVideoPrompt(input, style, configuredMotionPrompt = '') {
  const common = getAdditionalCommonPrompt(style.promptText, input.commonPromptText);
  const motion = cleanText(input.motionPrompt || configuredMotionPrompt || DEFAULT_MOTION_PROMPT, 4_000);
  return [
    input.sceneBeat ? `Story action: ${clipWords(input.sceneBeat, 35)}` : '',
    `Motion direction: ${clipWords(motion, 18)}`,
    input.scenePrompt ? `Scene visual prompt: ${clipWords(input.scenePrompt, 45)}` : '',
    `Style baseline: ${clipWords(style.promptText, 20)}`,
    common ? `Additional style direction: ${clipWords(common, 6)}` : '',
  ].filter(Boolean).join('\n\n');
}

function createVideoGenerationService({ config, provider, projectStore, styles }) {
  function resolve(publicPath, ownerId) {
    const match = String(publicPath || '').match(/^\/projects\/([^/]+)\/assets\/images\/([^/]+)$/);
    if (!match) return null;
    const projectId = decodeURIComponent(match[1]);
    const file = decodeURIComponent(match[2]);
    projectStore.read(projectId, { ownerId });
    if (file !== path.basename(file)) return null;
    return path.join(projectStore.assetDir(projectId, 'images'), file);
  }

  return {
    verify: () => provider.verify(),
    async generate(input, { ownerId, signal } = {}) {
      const source = resolve(input.imagePath, ownerId);
      if (!source || !fs.existsSync(source)) {
        throw new AppError('INVALID_PATH', 'A valid generated reference image is required', { status: 400 });
      }
      const style = styles.find(input.styleId);
      if (!style) throw new AppError('STYLE_NOT_FOUND', 'Unknown style', { status: 400 });

      const prompt = buildVideoPrompt(input, style, config.env.VIDEO_MOTION_PROMPT);
      const lease = projectStore.acquireLease(input.projectId, { ownerId });
      await provider.verify();
      fs.mkdirSync(config.paths.videos, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
      const staged = path.join(config.paths.videos, file);
      try {
        await provider.generate({
          imagePath: source,
          prompt,
          motionIntensity: input.motionIntensity,
          outputPath: staged,
        });
        const asset = projectStore.commitAsset(lease, 'videos', staged, { signal });
        return {
          video: {
            fileName: file,
            path: asset.path,
            sourceImagePath: input.imagePath,
            prompt,
            mimeType: 'video/mp4',
            provider: config.videoProvider,
          },
        };
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
}

module.exports = { DEFAULT_MOTION_PROMPT, buildVideoPrompt, createVideoGenerationService };
