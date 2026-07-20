const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectImageExtension } = require('../media/image-format');
const { AppError } = require('../errors');
const { imageShot } = require('../shared/scene-shots');
const { REFERENCE_ROLES, normalizeReferenceRole } = require('../shared/reference-roles');

const MAX_SHOT_REFERENCES = 8;

function createShotReferenceService({ config, projectStore }) {
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
    throw new AppError('PROJECT_WRITE_CONFLICT', 'Could not persist shot references after repeated conflicts', { status: 409 });
  }

  return {
    async upload(projectId, sceneId, files, { ownerId, userId } = {}) {
      if (!files?.length) throw new AppError('VALIDATION_ERROR', 'At least one image is required', { status: 400 });
      const lease = await projectStore.acquireLease(projectId, { ownerId, userId });
      const document = await projectStore.verifyLease(lease);
      const scene = document.scenes?.find((item) => item.id === sceneId);
      if (!scene) throw new AppError('SCENE_NOT_FOUND', 'Scene not found', { status: 404 });
      const shot = imageShot(scene);
      const existing = Array.isArray(shot.referenceBindings) ? shot.referenceBindings : [];
      if (existing.length + files.length > MAX_SHOT_REFERENCES) throw new AppError('REFERENCE_LIMIT', `A shot can have at most ${MAX_SHOT_REFERENCES} uploaded references`, { status: 400 });

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
          const targetShot = imageShot(target);
          targetShot.referenceBindings = [
            ...(Array.isArray(targetShot.referenceBindings) ? targetShot.referenceBindings : []),
            ...assets.map((asset, index) => ({ path: asset.path, fileName: prepared[index].file.originalname || asset.fileName, role: 'composition', createdAt: new Date().toISOString() })),
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
      const reference = imageShot(scene).referenceBindings?.find((item) => item?.path === assetPath);
      if (!reference) throw new AppError('REFERENCE_NOT_FOUND', 'Shot reference not found', { status: 404 });
      const result = await writeScene(lease, sceneId, (target) => {
        const targetShot = imageShot(target);
        targetShot.referenceBindings = (targetShot.referenceBindings || []).filter((item) => item?.path !== assetPath);
      });
      let fileName;
      try { fileName = decodeURIComponent(String(assetPath).split('/').pop()); } catch (_) { fileName = ''; }
      if (fileName) await projectStore.deleteAsset(projectId, 'images', fileName, { ownerId });
      return result;
    },

    async setRole(projectId, sceneId, assetPath, role, { ownerId, userId } = {}) {
      if (!REFERENCE_ROLES.includes(role)) throw new AppError('INVALID_REFERENCE_ROLE', 'Reference role must be character, location, composition, or continuity', { status: 400 });
      const lease = await projectStore.acquireLease(projectId, { ownerId, userId });
      const document = await projectStore.verifyLease(lease);
      const scene = document.scenes?.find((item) => item.id === sceneId);
      if (!imageShot(scene).referenceBindings?.some((item) => item?.path === assetPath)) throw new AppError('REFERENCE_NOT_FOUND', 'Shot reference not found', { status: 404 });
      return writeScene(lease, sceneId, (target) => {
        const targetShot = imageShot(target);
        targetShot.referenceBindings = (targetShot.referenceBindings || []).map((reference) => (
          reference?.path === assetPath ? { ...reference, role: normalizeReferenceRole(role) } : reference
        ));
      });
    },

    async uploadShotImage(projectId, sceneId, file, { ownerId, userId } = {}) {
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
          const shot = imageShot(target);
          shot.versions = [
            ...(Array.isArray(shot.versions) ? shot.versions : []),
            { path: asset.path, prompt: 'Uploaded shot image', createdAt: new Date().toISOString() },
          ];
          shot.activeVersionIndex = shot.versions.length - 1;
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

module.exports = { createShotReferenceService, MAX_SHOT_REFERENCES };
