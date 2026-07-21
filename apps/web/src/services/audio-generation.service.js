const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { slugify } = require('../shared/text');
const { providerOutput } = require('../providers/result');
const { AppError } = require('../errors');

const RECORDING_EXTENSIONS = Object.freeze({
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav',
});

function recordingMime(file) { return String(file?.mimetype || '').toLowerCase().split(';')[0]; }

function createAudioGenerationService({ config, provider, alignmentProvider, projectStore }) {
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
        // Alignment is additive, never blocking: a failed or unconfigured alignment step must
        // never fail audio generation, since audio is the critical path and alignment isn't.
        if (alignmentProvider) {
          try {
            const { words } = await alignmentProvider.align({ audioBuffer: result.buffer, transcript: input.narrationText, mimeType: result.mimeType });
            if (words?.length) version.alignment = { words };
          } catch (error) { /* alignment is additive; never fails audio generation */ }
        }
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
    async uploadRecording(input, file, { ownerId, userId, signal, jobId } = {}) {
      if (!file?.buffer?.length) throw new AppError('AUDIO_RECORDING_REQUIRED', 'An audio recording is required', { status: 400 });
      const mimeType = recordingMime(file);
      const extension = RECORDING_EXTENSIONS[mimeType];
      if (!extension) throw new AppError('UNSUPPORTED_AUDIO_FORMAT', 'Recordings must be WebM, Ogg, M4A, MP3, or WAV audio.', { status: 400 });
      const projectId = String(input.projectId || '');
      const sceneId = String(input.sceneId || '');
      if (!projectId || !sceneId) throw new AppError('VALIDATION_ERROR', 'projectId and sceneId are required', { status: 400 });
      const sceneNumber = Math.max(1, Math.min(200, Number.parseInt(input.sceneNumber, 10) || 1));
      const sceneTitle = String(input.sceneTitle || 'scene').slice(0, 200);
      const narrationText = String(input.narrationText || '').slice(0, 6_000);
      const durationSeconds = Number(input.durationSeconds);
      const lease = await projectStore.acquireLease(projectId, { ownerId, userId });
      await projectStore.verifyLease(lease, signal);
      fs.mkdirSync(config.paths.audio, { recursive: true });
      const fileName = `${String(sceneNumber).padStart(2, '0')}-${slugify(sceneTitle) || 'scene'}-recorded-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${extension}`;
      const staged = path.join(config.paths.audio, fileName);
      try {
        fs.writeFileSync(staged, file.buffer);
        const asset = await projectStore.commitAsset(lease, 'audio', staged, { signal, mimeType });
        const version = {
          path: asset.path, provider: 'recorded', narrationText, mimeType,
          ...(Number.isFinite(durationSeconds) && durationSeconds > 0 ? { durationSeconds } : {}),
          createdAt: new Date().toISOString(),
        };
        if (alignmentProvider && narrationText.trim()) {
          try {
            const { words } = await alignmentProvider.align({ audioBuffer: file.buffer, transcript: narrationText, mimeType });
            if (words?.length) version.alignment = { words };
          } catch (_) { /* alignment remains optional for user recordings */ }
        }
        let scene, project;
        try {
          ({ scene, project } = await projectStore.attachSceneVersion(lease, { sceneId, kind: 'audio', version, jobId }));
        } catch (error) {
          if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset); else fs.rmSync(asset.sourcePath, { force: true });
          throw error;
        }
        return { audio: { fileName, path: asset.path, mimeType, provider: 'recorded' }, scene, revision: project.revision };
      } finally { fs.rmSync(staged, { force: true }); }
    },
  };
}

module.exports = { createAudioGenerationService };
