const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { slugify } = require('../shared/text');
const { groupWordsIntoCues, buildSrt } = require('../shared/subtitles');

const CAPTION_STYLES = new Set(['classic', 'bold', 'minimal']);

// No provider call here -- subtitles are derived from the active audio version's already-computed
// alignment.words (see audio-generation.service.js), so generation is a fast, local, GPU-free
// grouping + SRT-formatting step, not another synthesis/alignment round trip.
function createSubtitleGenerationService({ config, projectStore }) {
  return {
    async generate(input, { ownerId, userId, signal, jobId } = {}) {
      const lease = await projectStore.acquireLease(input.projectId, { ownerId, userId });
      const document = await projectStore.verifyLease(lease, signal);
      const scene = document.scenes?.find((s) => s.id === input.sceneId);
      if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });

      const activeAudio = (scene.audioVersions || [])[scene.activeAudioVersionIndex];
      const words = activeAudio?.alignment?.words;
      if (!activeAudio?.path || !words?.length) {
        throw new AppError(
          'AUDIO_ALIGNMENT_REQUIRED',
          'This scene has no usable audio timing data yet. Generate (or regenerate) audio first.',
          { status: 409 },
        );
      }

      const cues = groupWordsIntoCues(words);
      const srt = buildSrt(cues);
      fs.mkdirSync(config.paths.subtitles, { recursive: true });
      const file = `${String(input.sceneNumber).padStart(2, '0')}-${slugify(input.sceneTitle || 'scene')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.srt`;
      const staged = path.join(config.paths.subtitles, file);
      try {
        fs.writeFileSync(staged, srt, 'utf8');
        const asset = await projectStore.commitAsset(lease, 'subtitles', staged, { signal, mimeType: 'application/x-subrip' });
        const version = {
          path: asset.path,
          words,
          cues,
          style: CAPTION_STYLES.has(input.captionStyle) ? input.captionStyle : 'classic',
          sourceAudioPath: activeAudio.path,
          narrationText: scene.narrationText || '',
          createdAt: new Date().toISOString(),
        };
        let sceneOut, project;
        try {
          ({ scene: sceneOut, project } = await projectStore.attachSceneVersion(lease, { sceneId: input.sceneId, kind: 'subtitle', version, jobId }));
        } catch (error) {
          if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true });
          throw error;
        }
        return { subtitle: { fileName: file, path: asset.path, cueCount: cues.length, style: version.style }, scene: sceneOut, revision: project.revision };
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },
  };
}

module.exports = { createSubtitleGenerationService };
