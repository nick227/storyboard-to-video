const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const webRoot = path.join(__dirname, '..');
const publishControlsPromise = import(path.join(webRoot, 'public', 'js', 'scripts', 'publish.js'));
const storePromise = import(path.join(webRoot, 'public', 'js', 'core', 'store.js'));

function element(extra = {}) {
  return {
    listeners: {},
    dataset: {},
    checked: false,
    disabled: false,
    closest() { return null; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    ...extra,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockVisibilityApi(serverScript, { fail = () => false } = {}) {
  const requested = [];
  return {
    requested,
    fetch: async (url, options = {}) => {
      if (options.method === 'POST' && String(url).endsWith('/visibility')) {
        const body = JSON.parse(options.body);
        requested.push(body);
        if (fail()) return jsonResponse({ error: { message: 'Publish failed' } }, 500);
        const artifact = body.artifact || 'screenplay';
        const field = artifact === 'storyboard' ? 'storyboardVisibility'
          : artifact === 'timeline' ? 'timelineVisibility'
            : 'visibility';
        Object.assign(serverScript, {
          [field]: body.visibility,
          visibility: artifact === 'screenplay' ? body.visibility : serverScript.visibility,
          artifacts: {
            ...serverScript.artifacts,
            [artifact]: {
              visibility: body.visibility,
              publishedAt: body.visibility === 'public' ? '2026-01-01T00:00:00.000Z' : null,
            },
          },
        });
        return jsonResponse({ ok: true, script: serverScript });
      }
      if (String(url) === `/api/scripts/${serverScript.id}`) {
        return jsonResponse({ ok: true, script: serverScript });
      }
      throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
    },
  };
}

test('workbar Public toggle publishes the active artifact from the current view', async (t) => {
  const { initScriptPublishControls } = await publishControlsPromise;
  const { projectStore } = await storePromise;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const serverScript = {
    id: 'script-1',
    slug: 'test-script',
    visibility: 'private',
    artifacts: {
      screenplay: { visibility: 'private', publishedAt: null },
      storyboard: { visibility: 'private', publishedAt: null },
      timeline: { visibility: 'private', publishedAt: null },
    },
    sharePaths: {
      screenplay: '/anonymous/test-script/screenplay',
      storyboard: '/anonymous/test-script/storyboard',
      timeline: '/anonymous/test-script/timeline',
    },
  };
  let failVisibilityUpdate = false;
  const api = mockVisibilityApi(serverScript, { fail: () => failVisibilityUpdate });
  global.fetch = api.fetch;

  projectStore.set({
    currentId: 'project-1',
    storyboards: [{ id: 'project-1', scriptId: serverScript.id, script: { ...serverScript } }],
  });

  const toggle = element();
  const shareBtn = element();
  const statuses = [];
  let artifact = 'screenplay';
  const controls = initScriptPublishControls({
    workVisibilityToggle: toggle,
    workShareBtn: shareBtn,
  }, {
    setStatus: (message) => statuses.push(message),
    getArtifact: () => artifact,
  });

  toggle.checked = true;
  await toggle.listeners.change();
  assert.deepEqual(api.requested, [{ visibility: 'public', artifact: 'screenplay' }]);
  assert.equal(serverScript.visibility, 'public');
  assert.equal(shareBtn.disabled, false);

  artifact = 'storyboard';
  await controls.syncFromRecord();
  assert.equal(toggle.checked, false);
  assert.equal(shareBtn.disabled, true);

  toggle.checked = true;
  await toggle.listeners.change();
  assert.deepEqual(api.requested.at(-1), { visibility: 'public', artifact: 'storyboard' });
  assert.equal(serverScript.visibility, 'public');
  assert.equal(serverScript.artifacts.storyboard.visibility, 'public');
  assert.equal(shareBtn.dataset.sharePath, '/anonymous/test-script/storyboard');
  assert.equal(statuses.at(-1), 'Storyboard is public.');

  failVisibilityUpdate = true;
  toggle.checked = false;
  await toggle.listeners.change();
  assert.equal(toggle.checked, true);
  assert.equal(statuses.at(-1), 'Publish failed');
});
