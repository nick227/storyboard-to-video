const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildProjectAssetPublicPath,
  buildProjectAssetStorageKey,
  createBlobStore,
  createLocalBlobStore,
} = require('../src/storage/blob-store');
const { loadConfig } = require('../src/config/env');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blob-store-'));
}

test('buildProjectAssetStorageKey and public path stay aligned', () => {
  const storageKey = buildProjectAssetStorageKey('proj-1', 'images', 'scene.png');
  assert.equal(storageKey, 'projects/proj-1/assets/images/scene.png');
  assert.equal(buildProjectAssetPublicPath('proj-1', 'images', 'scene.png'), '/projects/proj-1/assets/images/scene.png');
});

test('LocalBlobStore put/getStream/delete/exists', async () => {
  const root = tempRoot();
  const store = createLocalBlobStore({ root });
  const source = path.join(root, 'stage.bin');
  fs.writeFileSync(source, Buffer.from('payload'));
  const storageKey = buildProjectAssetStorageKey('p', 'images', 'kept.bin');

  store.put(storageKey, source, { mimeType: 'application/octet-stream', byteSize: 7 });
  assert.equal(store.exists(storageKey), true);
  assert.equal(store.resolveLocalPath(storageKey), path.join(root, 'p', 'assets', 'images', 'kept.bin'));
  assert.equal(fs.readFileSync(store.resolveLocalPath(storageKey), 'utf8'), 'payload');

  const chunks = [];
  await new Promise((resolve, reject) => {
    store.getStream(storageKey)
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  assert.equal(Buffer.concat(chunks).toString(), 'payload');

  store.delete(storageKey);
  assert.equal(store.exists(storageKey), false);
  assert.equal(store.resolveLocalPath(storageKey), null);
});

test('LocalBlobStore rejects duplicate keys', () => {
  const root = tempRoot();
  const store = createLocalBlobStore({ root });
  const source = path.join(root, 'stage.bin');
  fs.writeFileSync(source, Buffer.from('one'));
  const storageKey = buildProjectAssetStorageKey('p', 'images', 'dup.bin');
  store.put(storageKey, source);
  assert.throws(() => store.put(storageKey, source), (error) => error.code === 'ASSET_EXISTS');
});

test('createBlobStore defaults to local when STORAGE_BACKEND is unset', () => {
  const root = tempRoot();
  const config = loadConfig(root);
  const store = createBlobStore(config);
  assert.equal(store.backend, 'local');
});

test('createBlobStore fails startup for r2 without credentials', () => {
  const root = tempRoot();
  const config = loadConfig(root);
  config.storage.backend = 'r2';
  assert.throws(() => createBlobStore(config), /requires R2 configuration/);
});

test('createBlobStore fails startup for dual without credentials', () => {
  const root = tempRoot();
  const config = loadConfig(root);
  config.storage.backend = 'dual';
  assert.throws(() => createBlobStore(config), /requires R2 configuration/);
});

test('createBlobStore rejects unknown backend', () => {
  const root = tempRoot();
  const config = loadConfig(root);
  config.storage.backend = 's3';
  assert.throws(() => createBlobStore(config), /Invalid STORAGE_BACKEND/);
});
