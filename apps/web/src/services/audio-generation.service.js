const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { slugify } = require('../shared/text');
const { providerOutput } = require('../providers/result');

function createAudioGenerationService({ config, provider, projectStore }) {
  return {
    async generate(input, { ownerId, userId, signal, jobId } = {}) {
      const lease = await projectStore.acquireLease(input.projectId, { ownerId, userId });
      const result = providerOutput(await provider.generate({ provider: input.provider, narrationText: input.narrationText, voice: input.voice }));
      fs.mkdirSync(config.paths.audio, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${result.extension}`;
      const staged = path.join(config.paths.audio, file);
      try {
        fs.writeFileSync(staged, result.buffer);
        const asset = await projectStore.commitAsset(lease, 'audio', staged, { signal, mimeType: result.mimeType });
        // `narrationText` mirrors how image versions already store the `prompt` they were generated
        // from and video versions store `sourceImagePath` — lets audio staleness be derived the same
        // way (compare this snapshot to the scene's current narrationText) without a separate flag.
        const version = { path: asset.path, provider: input.provider, narrationText: input.narrationText, createdAt: new Date().toISOString() };
        let scene, project;
        try {
          ({ scene, project } = await projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'audio', version, jobId }));
        } catch (error) {
          if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true });
          throw error;
        }
        return { audio: { fileName: file, path: asset.path, mimeType: result.mimeType, provider: input.provider }, scene, revision: project.revision };
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
}

module.exports = { createAudioGenerationService };
