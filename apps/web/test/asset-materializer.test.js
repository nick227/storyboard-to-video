const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createLocalBlobStore, buildProjectAssetStorageKey } = require('../src/storage/blob-store');
const { createAssetMaterializer } = require('../src/storage/asset-materializer');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'materializer-'));
}

test('AssetMaterializer borrows canonical local paths without copying', async () => {
  const root = tempRoot();
  const blobStore = createLocalBlobStore({ root: path.join(root, 'projects') });
  const cacheDir = path.join(root, 'cache');
  const materializer = createAssetMaterializer({ blobStore, cacheDir });
  const source = path.join(root, 'stage.bin');
  fs.writeFileSync(source, 'bytes');
  const storageKey = buildProjectAssetStorageKey('p', 'images', 'a.bin');
  await blobStore.put(storageKey, source);
  const handle = await materializer.materialize(storageKey);
  assert.equal(handle.ephemeral, false);
  assert.equal(handle.path, blobStore.resolveLocalPath(storageKey));
  assert.equal(fs.readdirSync(cacheDir).length, 0);
  await handle.release();
  assert.equal(await blobStore.exists(storageKey), true);
});

test('AssetMaterializer streams remote-only assets into ephemeral cache and releases them', async () => {
  const root = tempRoot();
  const cacheDir = path.join(root, 'cache');
  const objects = new Map();
  const blobStore = {
    resolveLocalPath() { return null; },
    async exists(storageKey) { return objects.has(storageKey); },
    async getStream(storageKey) { return Readable.from([objects.get(storageKey)]); },
  };
  const materializer = createAssetMaterializer({ blobStore, cacheDir });
  const storageKey = buildProjectAssetStorageKey('p', 'images', 'remote.bin');
  objects.set(storageKey, Buffer.from('from-r2'));
  const handle = await materializer.materialize(storageKey);
  assert.equal(handle.ephemeral, true);
  assert.equal(fs.readFileSync(handle.path, 'utf8'), 'from-r2');
  assert.equal(fs.readdirSync(cacheDir).length, 1);
  await handle.release();
  assert.equal(fs.readdirSync(cacheDir).length, 0);
});

test('AssetMaterializer falls back to resolveLocalPath when getStream fails', async () => {
  const root = tempRoot();
  const localFile = path.join(root, 'legacy.bin');
  fs.writeFileSync(localFile, 'legacy');
  let resolveCalls = 0;
  const blobStore = {
    resolveLocalPath() {
      resolveCalls += 1;
      return resolveCalls > 1 ? localFile : null;
    },
    async exists() { return true; },
    async getStream() { throw new Error('r2 unavailable'); },
  };
  const materializer = createAssetMaterializer({ blobStore, cacheDir: path.join(root, 'cache') });
  const handle = await materializer.materialize('projects/p/assets/images/legacy.bin');
  assert.equal(handle.ephemeral, false);
  assert.equal(handle.path, localFile);
  assert.equal(resolveCalls, 2);
});
