const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../errors');
const { buildProjectAssetStorageKey } = require('../storage/blob-store');

function createAssetsController({ projectStore, styles, scripts }) {
  const PUBLIC_MEDIA_TYPES = new Set(['images', 'audio', 'videos', 'subtitles', 'scene-images']);

  async function resolveProjectAsset(req) {
    const file = path.basename(req.params.fileName);
    if (file !== req.params.fileName) throw new AppError('INVALID_PATH', 'Invalid asset path', { status: 400 });

    const ownerId = req.auth?.tenantId || null;
    if (ownerId) {
      try {
        if (projectStore.findAsset) {
          const asset = await projectStore.findAsset(req.params.projectId, req.params.type, file, { ownerId });
          return { storageKey: asset.storageKey, mimeType: asset.mimeType || null };
        }
        await projectStore.read(req.params.projectId, { ownerId });
        const storageKey = buildProjectAssetStorageKey(req.params.projectId, req.params.type, file);
        if (!await projectStore.blobStore.exists(storageKey)) {
          throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
        }
        return { storageKey, mimeType: null };
      } catch (error) {
        if (error.code !== 'PROJECT_NOT_FOUND' && error.status !== 404) throw error;
      }
    }

    if (!PUBLIC_MEDIA_TYPES.has(req.params.type)) {
      throw new AppError(ownerId ? 'ASSET_NOT_FOUND' : 'UNAUTHENTICATED',
        ownerId ? 'Asset not found' : 'Authentication is required',
        { status: ownerId ? 404 : 401 });
    }

    const allowed = scripts?.canPublicReadProjectMedia
      ? await scripts.canPublicReadProjectMedia(req.params.projectId)
      : false;
    if (!allowed) {
      throw new AppError(ownerId ? 'ASSET_NOT_FOUND' : 'UNAUTHENTICATED',
        ownerId ? 'Asset not found' : 'Authentication is required',
        { status: ownerId ? 404 : 401 });
    }

    if (projectStore.findAsset) {
      const asset = await projectStore.findAsset(req.params.projectId, req.params.type, file, {});
      return { storageKey: asset.storageKey, mimeType: asset.mimeType || null };
    }
    await projectStore.read(req.params.projectId);
    const storageKey = buildProjectAssetStorageKey(req.params.projectId, req.params.type, file);
    if (!await projectStore.blobStore.exists(storageKey)) {
      throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
    }
    return { storageKey, mimeType: null };
  }

  return {
    async project(req, res) {
      const { storageKey, mimeType } = await resolveProjectAsset(req);
      const stream = await projectStore.blobStore.getStream(storageKey);
      if (mimeType) res.type(mimeType);
      await pipeline(stream, res);
    },

    style(req, res) {
      const file = path.basename(req.params.fileName);
      if (file !== req.params.fileName) throw new AppError('INVALID_PATH', 'Invalid reference path', { status: 400 });
      const source = path.join(styles.referenceDir(req.params.styleId, req.params.type), file);
      if (!fs.existsSync(source)) throw new AppError('ASSET_NOT_FOUND', 'Reference asset not found', { status: 404 });
      res.sendFile(source);
    },

    userStyle(req, res) {
      if (!req.auth?.userId) throw new AppError('UNAUTHENTICATED', 'Not authenticated', { status: 401 });
      const file = path.basename(req.params.fileName);
      if (file !== req.params.fileName) throw new AppError('INVALID_PATH', 'Invalid reference path', { status: 400 });
      const source = path.join(styles.userReferenceDir(req.params.styleId, req.params.type, req.auth.userId), file);
      if (!fs.existsSync(source)) throw new AppError('ASSET_NOT_FOUND', 'User reference asset not found', { status: 404 });
      res.sendFile(source);
    },
  };
}

module.exports = { createAssetsController };
