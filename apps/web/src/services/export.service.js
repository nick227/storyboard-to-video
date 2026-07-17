const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const archiver = require('archiver');
const { slugify } = require('../shared/text');

function createExportService({ config, projectStore }) {
  async function resolve(publicPath, type, ownerId) {
    const match = String(publicPath || '').match(new RegExp(`^/projects/([^/]+)/assets/${type}/([^/]+)$`));
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    const file = decodeURIComponent(match[2]);
    if (file !== path.basename(file)) return null;
    if (projectStore.findAsset) return { file, sourcePath: (await projectStore.findAsset(id, type, file, { ownerId })).sourcePath };
    await projectStore.read(id, { ownerId });
    return { file, sourcePath: path.join(projectStore.assetDir(id, type), file) };
  }

  return {
    async generate(projectId, { ownerId, userId } = {}) {
      const project = await projectStore.read(projectId, { ownerId });
      const scenes = Array.isArray(project.scenes) ? project.scenes.slice(0, 50) : [];
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
          for (let index = 0; index < scenes.length; index += 1) {
            const scene = scenes[index];
            const number = String(index + 1).padStart(2, '0');
            const name = slugify(scene.title || 'scene');
            for (const item of [
              [scene.versions, scene.activeVersionIndex, 'images', 'images', '.png'],
              [scene.videoVersions, scene.activeVideoVersionIndex, 'videos', 'videos', '.mp4'],
              [scene.audioVersions, scene.activeAudioVersionIndex, 'audio', 'audio', '.wav'],
            ]) {
              const [versions, activeIndex, type, folder, defaultExtension] = item;
              const active = Array.isArray(versions) ? versions[Number.isInteger(activeIndex) ? activeIndex : 0] : null;
              const asset = await resolve(active?.path, type, ownerId);
              if (asset && fs.existsSync(asset.sourcePath)) archive.file(asset.sourcePath, { name: `${folder}/${number}-${name}${path.extname(asset.file) || defaultExtension}` });
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

module.exports = { createExportService };
