const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAdditionalCommonPrompt, slugify } = require('../shared/text');

function createImageGenerationService({ config, styles, provider, projectStore }) {
  return {
    async generate(input, { ownerId, signal, jobId } = {}) {
      const style = styles.find(input.styleId);
      if (!style) {
        const error = new Error('Unknown style');
        error.statusCode = 400;
        throw error;
      }
      const common = getAdditionalCommonPrompt(style.promptText, input.commonPromptText);
      const prompt = [style.promptText, common, input.scenePrompt, input.extraPromptText].filter(Boolean).join('\n\n');
      const references = input.provider === 'gemini' ? styles.referencePaths(style.id) : [];
      const lease = projectStore.acquireLease(input.projectId, { ownerId });
      const result = await provider.generate({ provider: input.provider, prompt, references, title: input.sceneTitle });
      fs.mkdirSync(config.paths.generated, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${result.extension}`;
      const staged = path.join(config.paths.generated, file);
      try {
        fs.writeFileSync(staged, result.buffer);
        const asset = projectStore.commitAsset(lease, 'images', staged, { signal });
        const version = { path: asset.path, prompt, createdAt: new Date().toISOString() };
        let scene, project;
        try {
          ({ scene, project } = projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'image', version, jobId }));
        } catch (error) {
          fs.rmSync(asset.sourcePath, { force: true });
          throw error;
        }
        return { image: { fileName: file, path: asset.path, prompt, mimeType: result.mimeType }, referenceCount: references.length, scene, revision: project.revision };
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
}

module.exports = { createImageGenerationService };
