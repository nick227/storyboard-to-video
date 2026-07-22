const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../errors');

/**
 * Temporary filesystem access for APIs that require local paths.
 * Never canonical — BlobStore remains source of truth.
 *
 * - If a local canonical path exists, it is borrowed (release is a no-op).
 * - Otherwise bytes are streamed into cacheDir and released after use.
 */
function createAssetMaterializer({ blobStore, cacheDir }) {
  if (!blobStore) throw new Error('blobStore is required');
  if (!cacheDir) throw new Error('cacheDir is required');
  fs.mkdirSync(cacheDir, { recursive: true });

  async function materialize(storageKey) {
    if (!storageKey) throw new AppError('INVALID_PATH', 'storageKey is required', { status: 400 });

    const borrowed = typeof blobStore.resolveLocalPath === 'function'
      ? blobStore.resolveLocalPath(storageKey)
      : null;
    if (borrowed) {
      return { path: borrowed, ephemeral: false, async release() {} };
    }

    if (!await blobStore.exists(storageKey)) {
      throw new AppError('ASSET_NOT_FOUND', 'Asset not found', { status: 404 });
    }

    const temp = path.join(cacheDir, `${crypto.randomUUID()}-${path.basename(storageKey)}`);
    try {
      const stream = await blobStore.getStream(storageKey);
      await pipeline(stream, fs.createWriteStream(temp));
    } catch (error) {
      fs.rmSync(temp, { force: true });
      // Graceful last chance: local path appeared or resolveLocalPath works after stream failure.
      const fallback = typeof blobStore.resolveLocalPath === 'function'
        ? blobStore.resolveLocalPath(storageKey)
        : null;
      if (fallback) return { path: fallback, ephemeral: false, async release() {} };
      throw error;
    }

    return {
      path: temp,
      ephemeral: true,
      async release() { fs.rmSync(temp, { force: true }); },
    };
  }

  return { materialize };
}

module.exports = { createAssetMaterializer };
