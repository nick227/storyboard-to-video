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

test('script visibility sends the user choice captured before the script refresh', async (t) => {
  const { initScriptPublishControls } = await publishControlsPromise;
  const { projectStore } = await storePromise;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let serverScript = {
    id: 'script-1',
    slug: 'test-script',
    sharePath: '/scripts/test-script',
    visibility: 'private',
  };
  let failVisibilityUpdate = false;
  const requestedVisibilities = [];
  global.fetch = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).endsWith('/visibility')) {
      const { visibility } = JSON.parse(options.body);
      requestedVisibilities.push(visibility);
      if (failVisibilityUpdate) {
        return jsonResponse({ error: { message: 'Publish failed' } }, 500);
      }
      serverScript = { ...serverScript, visibility };
      return jsonResponse({ ok: true, script: serverScript });
    }
    if (String(url) === '/api/scripts/script-1') {
      return jsonResponse({ ok: true, script: serverScript });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  projectStore.set({
    currentId: 'project-1',
    storyboards: [{
      id: 'project-1',
      scriptId: serverScript.id,
      script: { ...serverScript },
    }],
  });

  const toggle = element();
  const shareBtn = element();
  const statuses = [];
  initScriptPublishControls({
    scriptVisibilityToggle: toggle,
    scriptShareBtn: shareBtn,
  }, { setStatus: (message) => statuses.push(message) });

  toggle.checked = true;
  await toggle.listeners.change();

  assert.deepEqual(requestedVisibilities, ['public']);
  assert.equal(serverScript.visibility, 'public');
  assert.equal(toggle.checked, true);
  assert.equal(projectStore.get().storyboards[0].script.visibility, 'public');

  toggle.checked = false;
  await toggle.listeners.change();

  assert.deepEqual(requestedVisibilities, ['public', 'private']);
  assert.equal(serverScript.visibility, 'private');
  assert.equal(toggle.checked, false);
  assert.equal(projectStore.get().storyboards[0].script.visibility, 'private');

  failVisibilityUpdate = true;
  toggle.checked = true;
  await toggle.listeners.change();

  assert.deepEqual(requestedVisibilities, ['public', 'private', 'public']);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.equal(projectStore.get().storyboards[0].script.visibility, 'private');
  assert.equal(statuses.at(-1), 'Publish failed');
});
