const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../errors');
const { buildProjectAssetStorageKey } = require('../storage/blob-store');

function createAssetsController({ projectStore, styles }) {
  return {
    async project(req, res) {
      const file = path.basename(req.params.fileName);
      if (file !== req.params.fileName) throw new AppError('INVALID_PATH', 'Invalid asset path', { status: 400 });

      let storageKey;
      let mimeType = null;
      if (projectStore.findAsset) {
        const asset = await projectStore.findAsset(req.params.projectId, req.params.type, file, { ownerId: req.auth.tenantId });
        storageKey = asset.storageKey;
        mimeType = asset.mimeType || null;
      } else {
        await projectStore.read(req.params.projectId, { ownerId: req.auth.tenantId });
        storageKey = buildProjectAssetStorageKey(req.params.projectId, req.params.type, file);
        if (!await projectStore.blobStore.exists(storageKey)) {
          throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
        }
      }

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
