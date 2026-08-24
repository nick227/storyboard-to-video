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
  const metaRequested = [];
  return {
    requested,
    metaRequested,
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
      if (options.method === 'PUT' && String(url) === `/api/scripts/${serverScript.id}`) {
        const body = JSON.parse(options.body);
        metaRequested.push(body);
        Object.assign(serverScript, body);
        return jsonResponse({ ok: true, script: serverScript });
      }
      if (String(url) === `/api/scripts/${serverScript.id}`) {
        return jsonResponse({ ok: true, script: serverScript });
      }
      throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
    },
  };
}

test('global Public switch publishes every artifact and remains stable between views', async (t) => {
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
  assert.deepEqual(api.requested, [
    { visibility: 'public', artifact: 'screenplay' },
    { visibility: 'public', artifact: 'storyboard' },
    { visibility: 'public', artifact: 'timeline' },
  ]);
  assert.equal(serverScript.visibility, 'public');
  assert.equal(shareBtn.disabled, false);

  artifact = 'storyboard';
  await controls.syncFromRecord();
  assert.equal(toggle.checked, true);
  assert.equal(shareBtn.disabled, false);
  assert.equal(serverScript.artifacts.storyboard.visibility, 'public');
  assert.equal(shareBtn.dataset.sharePath, '/anonymous/test-script/storyboard');
  assert.equal(statuses.at(-1), 'Screenplay, Storyboard, and Timeline are public.');

  failVisibilityUpdate = true;
  toggle.checked = false;
  await toggle.listeners.change();
  assert.equal(toggle.checked, true);
  assert.equal(statuses.at(-1), 'Publish failed');
});

test('title page fields autosave through existing script metadata', async (t) => {
  const { initScriptPublishControls } = await publishControlsPromise;
  const { projectStore } = await storePromise;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const serverScript = {
    id: 'script-title-page',
    slug: 'untitled',
    title: 'Untitled',
    author: 'Anonymous',
    logline: '',
    summary: '',
    visibility: 'private',
    artifacts: {
      screenplay: { visibility: 'private' },
      storyboard: { visibility: 'private' },
      timeline: { visibility: 'private' },
    },
  };
  const api = mockVisibilityApi(serverScript);
  global.fetch = api.fetch;
  projectStore.set({
    currentId: 'project-title-page',
    storyboards: [{ id: 'project-title-page', scriptId: serverScript.id, script: { ...serverScript } }],
  });
  let title = '';
  let applied = null;
  const controls = initScriptPublishControls({ workVisibilityToggle: element() }, {
    setTitle: (value) => { title = value; },
    onScriptMetaChange: (script) => { applied = script; },
  });

  controls.queueTitlePageMeta({
    title: 'The Long Way Home',
    author: 'Morgan Lee',
    logline: 'A pilot follows a signal beyond the mapped sky.',
    summary: 'A restrained science-fiction drama.',
  });
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.equal(title, 'The Long Way Home');
  assert.deepEqual(api.metaRequested, [{
    title: 'The Long Way Home',
    author: 'Morgan Lee',
    logline: 'A pilot follows a signal beyond the mapped sky.',
    summary: 'A restrained science-fiction drama.',
  }]);
  assert.equal(applied.author, 'Morgan Lee');
});
