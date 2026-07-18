const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectImageExtension } = require('../media/image-format');
const { AppError } = require('../errors');

const MAX_SCENE_REFERENCES = 8;

function createSceneReferenceService({ config, projectStore }) {
  async function rollback(assets) {
    for (const asset of assets) {
      if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset);
      else if (asset?.sourcePath) fs.rmSync(asset.sourcePath, { force: true });
    }
  }

  async function writeScene(lease, sceneId, mutate) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const document = await projectStore.verifyLease(lease);
      const scene = document.scenes?.find((item) => item.id === sceneId);
      if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      mutate(scene);
      try {
        const project = await projectStore.write(lease.projectId, document, { expectedRevision: document.revision, ownerId: lease.ownerId });
        return { project, scene: project.scenes.find((item) => item.id === sceneId) };
      } catch (error) {
        if (error.code !== 'REVISION_CONFLICT') throw error;
      }
    }
    throw new AppError('PROJECT_WRITE_CONFLICT', 'Could not persist scene references after repeated conflicts', { status: 409 });
  }

  return {
    async upload(projectId, sceneId, files, { ownerId, userId } = {}) {
      if (!files?.length) throw new AppError('VALIDATION_ERROR', 'At least one image is required', { status: 400 });
      const lease = await projectStore.acquireLease(projectId, { ownerId, userId });
      const document = await projectStore.verifyLease(lease);
      const scene = document.scenes?.find((item) => item.id === sceneId);
      if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      const existing = Array.isArray(scene.referenceImages) ? scene.referenceImages : [];
      if (existing.length + files.length > MAX_SCENE_REFERENCES) throw new AppError('REFERENCE_LIMIT', `A scene can have at most ${MAX_SCENE_REFERENCES} uploaded references`, { status: 400 });

      const prepared = files.map((file) => ({ file, extension: detectImageExtension(file.buffer) }));
      if (prepared.some((item) => !item.extension)) throw new AppError('INVALID_IMAGE', 'Only valid PNG, JPEG, WebP, and GIF images are accepted', { status: 400 });

      const assets = [];
      try {
        for (const [index, item] of prepared.entries()) {
          const fileName = `scene-reference-${sceneId}-${Date.now()}-${index}-${crypto.randomBytes(3).toString('hex')}.${item.extension}`;
          const staged = path.join(config.paths.generated, `.${fileName}.upload`);
          fs.mkdirSync(config.paths.generated, { recursive: true });
          try {
            fs.writeFileSync(staged, item.file.buffer);
            assets.push(await projectStore.commitAsset(lease, 'images', staged, { fileName, mimeType: item.file.mimetype }));
          } finally {
            fs.rmSync(staged, { force: true });
          }
        }
        return await writeScene(lease, sceneId, (target) => {
          target.referenceImages = [
            ...(Array.isArray(target.referenceImages) ? target.referenceImages : []),
            ...assets.map((asset, index) => ({ path: asset.path, fileName: prepared[index].file.originalname || asset.fileName, createdAt: new Date().toISOString() })),
          ];
        });
      } catch (error) {
        await rollback(assets);
        throw error;
      }
    },

    async remove(projectId, sceneId, assetPath, { ownerId, userId } = {}) {
      const lease = await projectStore.acquireLease(projectId, { ownerId, userId });
      const document = await projectStore.verifyLease(lease);
      const scene = document.scenes?.find((item) => item.id === sceneId);
      const reference = scene?.referenceImages?.find((item) => item?.path === assetPath);
      if (!reference) throw new AppError('REFERENCE_NOT_FOUND', 'Scene reference not found', { status: 404 });
      const result = await writeScene(lease, sceneId, (target) => {
        target.referenceImages = (target.referenceImages || []).filter((item) => item?.path !== assetPath);
      });
      let fileName;
      try { fileName = decodeURIComponent(String(assetPath).split('/').pop()); } catch (_) { fileName = ''; }
      if (fileName) await projectStore.deleteAsset(projectId, 'images', fileName, { ownerId });
      return result;
    },

    async uploadSceneImage(projectId, sceneId, file, { ownerId, userId } = {}) {
      if (!file) throw new AppError('VALIDATION_ERROR', 'An image is required', { status: 400 });
      const lease = await projectStore.acquireLease(projectId, { ownerId, userId });
      const document = await projectStore.verifyLease(lease);
      const scene = document.scenes?.find((item) => item.id === sceneId);
      if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });

      const extension = detectImageExtension(file.buffer);
      if (!extension) throw new AppError('INVALID_IMAGE', 'Only valid PNG, JPEG, WebP, and GIF images are accepted', { status: 400 });

      const fileName = `scene-image-${sceneId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${extension}`;
      const staged = path.join(config.paths.generated, `.${fileName}.upload`);
      fs.mkdirSync(config.paths.generated, { recursive: true });
      let asset;
      try {
        fs.writeFileSync(staged, file.buffer);
        asset = await projectStore.commitAsset(lease, 'scene-images', staged, { fileName, mimeType: file.mimetype });
      } finally {
        fs.rmSync(staged, { force: true });
      }

      try {
        return await writeScene(lease, sceneId, (target) => {
          target.versions = [
            ...(Array.isArray(target.versions) ? target.versions : []),
            { path: asset.path, prompt: 'Uploaded scene image', createdAt: new Date().toISOString() },
          ];
          target.activeVersionIndex = target.versions.length - 1;
          target.activeVisualType = 'image';
        });
      } catch (error) {
        if (projectStore.rollbackAsset) await projectStore.rollbackAsset(asset);
        else if (asset?.sourcePath) fs.rmSync(asset.sourcePath, { force: true });
        throw error;
      }
    },
  };
}

module.exports = { createSceneReferenceService, MAX_SCENE_REFERENCES };
