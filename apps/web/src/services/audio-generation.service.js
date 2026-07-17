const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { slugify } = require('../shared/text');

function createAudioGenerationService({ config, provider, projectStore }) {
  return {
    async generate(input, { ownerId, signal, jobId } = {}) {
      const lease = projectStore.acquireLease(input.projectId, { ownerId });
      const result = await provider.generate({ provider: input.provider, lines: input.lines, voiceMap: input.voiceMap });
      fs.mkdirSync(config.paths.audio, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${result.extension}`;
      const staged = path.join(config.paths.audio, file);
      try {
        fs.writeFileSync(staged, result.buffer);
        const asset = projectStore.commitAsset(lease, 'audio', staged, { signal });
        const version = { path: asset.path, provider: input.provider, createdAt: new Date().toISOString() };
        let scene, project;
        try {
          ({ scene, project } = projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'audio', version, jobId }));
        } catch (error) {
          fs.rmSync(asset.sourcePath, { force: true });
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
