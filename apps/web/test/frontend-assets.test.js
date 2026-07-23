const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const assetsPromise = import(path.join(__dirname, '..', 'public', 'modules', 'assets.js'));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('protected asset cache coalesces concurrent loads and revokes its single object URL', async () => {
  const { loadProtectedAsset, loadedAssets, revokeAllAssets } = await assetsPromise;
  const response = deferred();
  const originalFetch = global.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let fetchCount = 0;
  const revoked = [];
  global.fetch = () => { fetchCount++; return response.promise; };
  URL.createObjectURL = () => 'blob:coalesced';
  URL.revokeObjectURL = (url) => revoked.push(url);

  try {
    const first = loadProtectedAsset('/asset.png');
    const second = loadProtectedAsset('/asset.png');
    assert.equal(fetchCount, 1);
    response.resolve({ ok: true, blob: async () => new Blob(['image']) });
    assert.deepEqual(await Promise.all([first, second]), ['blob:coalesced', 'blob:coalesced']);
    assert.equal(loadedAssets.size, 1);
    revokeAllAssets();
    assert.deepEqual(revoked, ['blob:coalesced']);
    assert.equal(loadedAssets.size, 0);
  } finally {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    revokeAllAssets();
  }
});

test('cache cleanup prevents an older pending load from repopulating the cache', async () => {
  const { loadProtectedAsset, loadedAssets, revokeAllAssets } = await assetsPromise;
  const response = deferred();
  const originalFetch = global.fetch;
  const originalCreate = URL.createObjectURL;
  let createCount = 0;
  global.fetch = () => response.promise;
  URL.createObjectURL = () => { createCount++; return 'blob:stale'; };

  try {
    const pending = loadProtectedAsset('/stale.png');
    revokeAllAssets();
    response.resolve({ ok: true, blob: async () => new Blob(['stale']) });
    assert.equal(await pending, null);
    assert.equal(createCount, 0);
    assert.equal(loadedAssets.size, 0);
  } finally {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    revokeAllAssets();
  }
});

test('one caller can abort without cancelling another caller sharing the asset load', async () => {
  const { loadProtectedAsset, revokeAllAssets } = await assetsPromise;
  const response = deferred();
  const originalFetch = global.fetch;
  const originalCreate = URL.createObjectURL;
  global.fetch = () => response.promise;
  URL.createObjectURL = () => 'blob:shared';
  const controller = new AbortController();

  try {
    const aborted = loadProtectedAsset('/shared.png', { signal: controller.signal });
    const active = loadProtectedAsset('/shared.png');
    controller.abort();
    response.resolve({ ok: true, blob: async () => new Blob(['shared']) });
    await assert.rejects(aborted, (error) => error.name === 'AbortError');
    assert.equal(await active, 'blob:shared');
  } finally {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    revokeAllAssets();
  }
});
