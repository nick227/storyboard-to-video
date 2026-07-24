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
    sharePath: '/anonymous/test-script/screenplay',
    visibility: 'private',
    storyboardVisibility: 'private',
    timelineVisibility: 'private',
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
  const requestedVisibilities = [];
  const requestedArtifacts = [];
  global.fetch = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).endsWith('/visibility')) {
      const body = JSON.parse(options.body);
      requestedVisibilities.push(body.visibility);
      requestedArtifacts.push(body.artifact || 'screenplay');
      if (failVisibilityUpdate) {
        return jsonResponse({ error: { message: 'Publish failed' } }, 500);
      }
      const artifact = body.artifact || 'screenplay';
      const field = artifact === 'storyboard' ? 'storyboardVisibility'
        : artifact === 'timeline' ? 'timelineVisibility'
          : 'visibility';
      serverScript = {
        ...serverScript,
        [field]: body.visibility,
        visibility: artifact === 'screenplay' ? body.visibility : serverScript.visibility,
        artifacts: {
          ...serverScript.artifacts,
          [artifact]: {
            visibility: body.visibility,
            publishedAt: body.visibility === 'public' ? '2026-01-01T00:00:00.000Z' : null,
          },
        },
        sharePaths: {
          screenplay: '/anonymous/test-script/screenplay',
          storyboard: '/anonymous/test-script/storyboard',
          timeline: '/anonymous/test-script/timeline',
        },
      };
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
  assert.deepEqual(requestedArtifacts, ['screenplay']);
  assert.equal(serverScript.visibility, 'public');
  assert.equal(toggle.checked, true);
  assert.equal(projectStore.get().storyboards[0].script.visibility, 'public');

  toggle.checked = false;
  await toggle.listeners.change();

  assert.deepEqual(requestedVisibilities, ['public', 'private']);
  assert.deepEqual(requestedArtifacts, ['screenplay', 'screenplay']);
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

test('artifact visibility publishes the active storyboard independently', async (t) => {
  const { initScriptPublishControls } = await publishControlsPromise;
  const { projectStore } = await storePromise;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let serverScript = {
    id: 'script-2',
    slug: 'boarded',
    visibility: 'private',
    artifacts: {
      screenplay: { visibility: 'private', publishedAt: null },
      storyboard: { visibility: 'private', publishedAt: null },
      timeline: { visibility: 'private', publishedAt: null },
    },
    sharePaths: {
      screenplay: '/anonymous/boarded/screenplay',
      storyboard: '/anonymous/boarded/storyboard',
      timeline: '/anonymous/boarded/timeline',
    },
  };
  const requested = [];
  global.fetch = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).endsWith('/visibility')) {
      const body = JSON.parse(options.body);
      requested.push(body);
      serverScript = {
        ...serverScript,
        storyboardVisibility: body.visibility,
        artifacts: {
          ...serverScript.artifacts,
          storyboard: {
            visibility: body.visibility,
            publishedAt: body.visibility === 'public' ? '2026-01-01T00:00:00.000Z' : null,
          },
        },
      };
      return jsonResponse({ ok: true, script: serverScript });
    }
    if (String(url) === '/api/scripts/script-2') {
      return jsonResponse({ ok: true, script: serverScript });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  projectStore.set({
    currentId: 'project-2',
    storyboards: [{ id: 'project-2', scriptId: serverScript.id, script: { ...serverScript } }],
  });

  const toggle = element();
  const shareBtn = element();
  initScriptPublishControls({
    workVisibilityToggle: toggle,
    workShareBtn: shareBtn,
  }, { getArtifact: () => 'storyboard' });

  toggle.checked = true;
  await toggle.listeners.change();

  assert.deepEqual(requested, [{ visibility: 'public', artifact: 'storyboard' }]);
  assert.equal(serverScript.visibility, 'private');
  assert.equal(serverScript.artifacts.storyboard.visibility, 'public');
  assert.equal(shareBtn.disabled, false);
  assert.equal(shareBtn.dataset.sharePath, '/anonymous/boarded/storyboard');
});
