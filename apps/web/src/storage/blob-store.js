const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../errors');
const { createR2BlobStore } = require('./r2-blob-store');
const { createDualBlobStore } = require('./dual-blob-store');
const { createReadFallbackBlobStore } = require('./read-fallback-blob-store');

const PROJECT_ASSET_KEY_PATTERN = /^projects\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})\/assets\/(images|audio|videos|subtitles|exports|ai-references|scene-images)\/([^/]+)$/;

function buildProjectAssetStorageKey(projectId, type, fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!safeName || safeName !== fileName || safeName.includes('\\')) {
    throw new AppError('INVALID_PATH', 'Invalid asset filename', { status: 400 });
  }
  return `projects/${projectId}/assets/${type}/${safeName}`;
}

function buildProjectAssetPublicPath(projectId, type, fileName) {
  const safeName = path.basename(String(fileName || ''));
  return `/projects/${encodeURIComponent(projectId)}/assets/${type}/${encodeURIComponent(safeName)}`;
}

function parseProjectAssetStorageKey(storageKey) {
  const match = String(storageKey || '').match(PROJECT_ASSET_KEY_PATTERN);
  if (!match) throw new AppError('INVALID_PATH', 'Invalid asset storage key', { status: 400 });
  return { projectId: match[1], type: match[2], fileName: match[3] };
}

function localPathForStorageKey(root, storageKey) {
  const { projectId, type, fileName } = parseProjectAssetStorageKey(storageKey);
  return path.join(root, projectId, 'assets', type, fileName);
}

function createLocalBlobStore({ root }) {
  const resolvedRoot = path.resolve(root);

  return {
    backend: 'local',

    async put(storageKey, sourcePath, { mimeType } = {}) {
      void mimeType;
      const destination = localPathForStorageKey(resolvedRoot, storageKey);
      if (fs.existsSync(destination)) {
        throw new AppError('ASSET_EXISTS', 'An asset with that filename already exists', { status: 409 });
      }
      const dir = path.dirname(destination);
      const safeName = path.basename(destination);
      fs.mkdirSync(dir, { recursive: true });
      const temp = path.join(dir, `.${safeName}-${crypto.randomUUID()}.tmp`);
      fs.copyFileSync(sourcePath, temp, fs.constants.COPYFILE_EXCL);
      const tempFd = fs.openSync(temp, 'r');
      try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
      try {
        fs.renameSync(temp, destination);
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } finally {
        fs.rmSync(temp, { force: true });
      }
      return { storageKey };
    },

    async getStream(storageKey) {
      const filePath = localPathForStorageKey(resolvedRoot, storageKey);
      if (!fs.existsSync(filePath)) {
        throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
      }
      return fs.createReadStream(filePath);
    },

    async delete(storageKey) {
      fs.rmSync(localPathForStorageKey(resolvedRoot, storageKey), { force: true });
    },

    async exists(storageKey) {
      return fs.existsSync(localPathForStorageKey(resolvedRoot, storageKey));
    },

    resolveLocalPath(storageKey) {
      const filePath = localPathForStorageKey(resolvedRoot, storageKey);
      return fs.existsSync(filePath) ? filePath : null;
    },
  };
}

function assertR2Config(storage) {
  const fields = [
    ['accountId', 'R2_ACCOUNT_ID'],
    ['accessKeyId', 'R2_ACCESS_KEY_ID'],
    ['secretAccessKey', 'R2_SECRET_ACCESS_KEY'],
    ['bucket', 'R2_BUCKET'],
    ['endpoint', 'R2_ENDPOINT'],
  ];
  const missing = fields.filter(([key]) => !String(storage.r2[key] || '').trim()).map(([, envKey]) => envKey);
  if (missing.length) {
    throw new Error(`STORAGE_BACKEND=${storage.backend} requires R2 configuration: ${missing.join(', ')}`);
  }
}

function createBlobStore(config) {
  const backend = String(config.storage?.backend || 'local').toLowerCase();
  const local = createLocalBlobStore({ root: config.paths.projects });
  if (backend === 'local') return local;
  if (backend === 'r2' || backend === 'dual') {
    assertR2Config(config.storage);
    const remote = createR2BlobStore(config.storage.r2);
    if (backend === 'dual') return createDualBlobStore({ local, remote });
    // R2 writes; reads prefer R2 then legacy local disk.
    return createReadFallbackBlobStore({ primary: remote, fallback: local });
  }
  throw new Error(`Invalid STORAGE_BACKEND: ${backend}`);
}

module.exports = {
  buildProjectAssetStorageKey,
  buildProjectAssetPublicPath,
  parseProjectAssetStorageKey,
  createLocalBlobStore,
  createR2BlobStore,
  createDualBlobStore,
  createReadFallbackBlobStore,
  createBlobStore,
};
