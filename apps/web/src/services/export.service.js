const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const archiver = require('archiver');
const { MAX_PROJECT_SCENES } = require('../schemas');
const { slugify } = require('../shared/text');
const { imageShot } = require('../shared/scene-shots');

const SCREENPLAY_BUNDLE_PATH = 'script/screenplay.fountain';

function fountainBundleSource(scriptText) {
  const source = typeof scriptText === 'string' ? scriptText.replace(/\s+$/, '') : '';
  return `${source}\n`;
}

function createExportService({ config, projectStore }) {
  return {
    async generate(projectId, { ownerId, userId } = {}) {
      const project = await projectStore.read(projectId, { ownerId });
      const scenes = Array.isArray(project.scenes) ? project.scenes.slice(0, MAX_PROJECT_SCENES) : [];
      fs.mkdirSync(config.paths.zips, { recursive: true });
      const file = `storyboard-images-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.zip`;
      const staged = path.join(config.paths.zips, file);
      const output = fs.createWriteStream(staged);
      const archive = archiver('zip', { zlib: { level: 9 } });
      await new Promise(async (resolvePromise, reject) => {
        output.on('close', resolvePromise);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        try {
          archive.append(fountainBundleSource(project.scriptText), { name: SCREENPLAY_BUNDLE_PATH });
          for (let index = 0; index < scenes.length; index += 1) {
            const scene = scenes[index];
            const shot = imageShot(scene);
            const number = String(index + 1).padStart(2, '0');
            const name = slugify(scene.title || 'scene');
            for (const item of [
              [shot.versions, shot.activeVersionIndex, 'images', 'images', '.png'],
              [shot.videoVersions, shot.activeVideoVersionIndex, 'videos', 'videos', '.mp4'],
              [scene.audioVersions, scene.activeAudioVersionIndex, 'audio', 'audio', '.wav'],
              [scene.subtitleVersions, scene.activeSubtitleVersionIndex, 'subtitles', 'subtitles', '.srt'],
            ]) {
              const [versions, activeIndex, type, folder, defaultExtension] = item;
              const active = Array.isArray(versions) ? versions[Number.isInteger(activeIndex) ? activeIndex : 0] : null;
              if (active?.path) {
                const asset = await projectStore.resolveAsset(projectId, active.path, { ownerId });
                if (asset?.storageKey) {
                  const stream = await projectStore.blobStore.getStream(asset.storageKey);
                  archive.append(stream, { name: `${folder}/${number}-${name}${path.extname(asset.fileName) || defaultExtension}` });
                }
              }
            }
          }
          archive.append(JSON.stringify({ ...project, exportedAt: new Date().toISOString() }, null, 2), { name: 'storyboard.json' });
          await archive.finalize();
        } catch (error) { reject(error); }
      });
      try {
        const lease = await projectStore.acquireLease(projectId, { ownerId, userId });
        const asset = await projectStore.commitAsset(lease, 'exports', staged, { mimeType: 'application/zip' });
        return { zipPath: asset.path };
      } finally { fs.rmSync(staged, { force: true }); }
    },
  };
}

module.exports = { createExportService, fountainBundleSource, SCREENPLAY_BUNDLE_PATH };
