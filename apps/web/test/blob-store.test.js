const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  buildProjectAssetPublicPath,
  buildProjectAssetStorageKey,
  createBlobStore,
  createDualBlobStore,
  createLocalBlobStore,
  createR2BlobStore,
} = require('../src/storage/blob-store');
const { loadConfig } = require('../src/config/env');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blob-store-'));
}

function mockS3Client(objects = new Map()) {
  return {
    async send(command) {
      const name = command.constructor.name;
      const key = command.input.Key;
      if (name === 'HeadObjectCommand') {
        if (!objects.has(key)) {
          const error = new Error('NotFound');
          error.name = 'NotFound';
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        return {};
      }
      if (name === 'PutObjectCommand') {
        const chunks = [];
        for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks));
        return {};
      }
      if (name === 'GetObjectCommand') {
        if (!objects.has(key)) {
          const error = new Error('NoSuchKey');
          error.name = 'NoSuchKey';
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        return { Body: Readable.from([objects.get(key)]) };
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
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

  await store.put(storageKey, source, { mimeType: 'application/octet-stream', byteSize: 7 });
  assert.equal(await store.exists(storageKey), true);
  assert.equal(store.resolveLocalPath(storageKey), path.join(root, 'p', 'assets', 'images', 'kept.bin'));
  assert.equal(fs.readFileSync(store.resolveLocalPath(storageKey), 'utf8'), 'payload');

  const chunks = [];
  await new Promise((resolve, reject) => {
    store.getStream(storageKey).then((stream) => {
      stream.on('data', (chunk) => chunks.push(chunk)).on('end', resolve).on('error', reject);
    }, reject);
  });
  assert.equal(Buffer.concat(chunks).toString(), 'payload');

  await store.delete(storageKey);
  assert.equal(await store.exists(storageKey), false);
  assert.equal(store.resolveLocalPath(storageKey), null);
});

test('LocalBlobStore rejects duplicate keys', async () => {
  const root = tempRoot();
  const store = createLocalBlobStore({ root });
  const source = path.join(root, 'stage.bin');
  fs.writeFileSync(source, Buffer.from('one'));
  const storageKey = buildProjectAssetStorageKey('p', 'images', 'dup.bin');
  await store.put(storageKey, source);
  await assert.rejects(() => store.put(storageKey, source), (error) => error.code === 'ASSET_EXISTS');
});

test('R2BlobStore put/getStream/delete/exists with mocked S3 client', async () => {
  const root = tempRoot();
  const objects = new Map();
  const store = createR2BlobStore({
    bucket: 'storyboard',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    client: mockS3Client(objects),
  });
  const source = path.join(root, 'stage.bin');
  fs.writeFileSync(source, Buffer.from('r2-bytes'));
  const storageKey = buildProjectAssetStorageKey('p', 'images', 'cloud.bin');

  await store.put(storageKey, source, { mimeType: 'application/octet-stream' });
  assert.equal(await store.exists(storageKey), true);
  assert.equal(store.resolveLocalPath(storageKey), null);
  assert.equal(objects.get(storageKey).toString(), 'r2-bytes');

  const chunks = [];
  await new Promise((resolve, reject) => {
    store.getStream(storageKey).then((stream) => {
      stream.on('data', (chunk) => chunks.push(chunk)).on('end', resolve).on('error', reject);
    }, reject);
  });
  assert.equal(Buffer.concat(chunks).toString(), 'r2-bytes');

  await store.delete(storageKey);
  assert.equal(await store.exists(storageKey), false);
});

test('DualBlobStore writes local and remote; reads from local; survives remote put failure', async () => {
  const root = tempRoot();
  const local = createLocalBlobStore({ root });
  const remotePuts = [];
  const remote = {
    backend: 'r2',
    async put(storageKey, sourcePath, options) {
      remotePuts.push({ storageKey, options });
      if (options.fail) throw new Error('r2 down');
      return { storageKey };
    },
    async delete() {},
    async exists() { return false; },
    async getStream() { throw new Error('should not read remote'); },
    resolveLocalPath() { return null; },
  };
  const errors = [];
  const dual = createDualBlobStore({ local, remote, onRemoteError: (...args) => errors.push(args) });
  const source = path.join(root, 'stage.bin');
  fs.writeFileSync(source, Buffer.from('dual'));
  const storageKey = buildProjectAssetStorageKey('p', 'images', 'dual.bin');

  await dual.put(storageKey, source);
  assert.equal(await dual.exists(storageKey), true);
  assert.ok(dual.resolveLocalPath(storageKey));
  assert.equal(remotePuts.length, 1);
  assert.equal(remotePuts[0].options.overwrite, true);

  remote.put = async () => { throw new Error('r2 down'); };
  const secondKey = buildProjectAssetStorageKey('p', 'images', 'dual-2.bin');
  await dual.put(secondKey, source);
  assert.equal(await dual.exists(secondKey), true);
  assert.equal(errors.length, 1);
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

test('createBlobStore wires dual when R2 config is complete', () => {
  const root = tempRoot();
  const config = loadConfig(root);
  config.storage.backend = 'dual';
  config.storage.r2 = {
    accountId: 'acct',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'bucket',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
  };
  const store = createBlobStore(config);
  assert.equal(store.backend, 'dual');
});

test('createBlobStore wires r2 when R2 config is complete', () => {
  const root = tempRoot();
  const config = loadConfig(root);
  config.storage.backend = 'r2';
  config.storage.r2 = {
    accountId: 'acct',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'bucket',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
  };
  const store = createBlobStore(config);
  assert.equal(store.backend, 'r2');
});

test('createBlobStore rejects unknown backend', () => {
  const root = tempRoot();
  const config = loadConfig(root);
  config.storage.backend = 's3';
  assert.throws(() => createBlobStore(config), /Invalid STORAGE_BACKEND/);
});
