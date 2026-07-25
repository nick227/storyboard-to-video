// Bulk-generation UX plan: within a batch (withinSerial=true), regenerateImage/regenerateAudio (and
// the other regenerate* functions in workflows.js) split failures into two kinds:
//   - an EXPECTED rejection tied to this specific request (a well-formed 4xx from our own API — bad
//     prompt, provider content rejection, validation, etc.) returns a structured
//     { outcome: 'failed', reason } so batchController.start can record it and keep going.
//   - a SYSTEMIC failure (no HTTP status at all, a 5xx, or a 429) still throws, so batch.js stops the
//     whole batch instead of burning through the rest of the range against whatever's actually broken.
// The single-scene, non-serial call path (entity-modal "Regenerate" button) is untouched either way —
// it always throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function installLocalStorageShim() {
  const data = new Map();
  global.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

async function setupProject({ scene }) {
  const { projectStore, sceneStore, uiStore } = await import(path.join(__dirname, '..', 'public', 'js', 'core', 'store.js'));
  const record = {
    id: 'workflow-outcomes-test-project',
    title: 'Workflow Outcomes Test',
    revision: 1,
    scenes: [scene],
    imageProvider: 'stub', // skips the /api/images/preflight round trip
    audioProvider: 'stub',
  };
  projectStore.set({ currentId: record.id, storyboards: [record] });
  sceneStore.set({ scenes: [scene] });
  uiStore.set({ operation: null });
  return record;
}

const baseEls = {
  scriptText: { value: 'A short opening for the story.' },
  styleSelect: { value: 'basic-cartoon' },
  commonPromptText: { value: '' },
  textProvider: { value: 'gemini' },
  imageProvider: { value: 'stub' },
  audioProvider: { value: 'stub' },
  fallbackPolicy: { value: 'fail' },
  enrichNarration: { checked: false },
};

test('regenerateImage(withinSerial=true) returns a failed outcome (not a throw) for an expected 4xx rejection', async () => {
  installLocalStorageShim();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith('/api/images/generate')) return jsonResponse({ error: 'prompt rejected by content policy' }, 422);
    return jsonResponse({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { regenerateImage } = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'workflows.js'));
    const scene = { id: 'scene-1', prompt: 'A hero stands on a cliff.' };
    await setupProject({ scene });

    const result = await regenerateImage(0, scene, baseEls, () => {}, true);
    assert.deepEqual(Object.keys(result).sort(), ['outcome', 'reason']);
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason, /content policy/);
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('regenerateAudio(withinSerial=true) returns a failed outcome (not a throw) for an expected 4xx rejection', async () => {
  installLocalStorageShim();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith('/api/audio/generate')) return jsonResponse({ error: 'narration text failed validation' }, 400);
    return jsonResponse({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { regenerateAudio } = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'workflows.js'));
    const scene = { id: 'scene-1', narrationText: 'Once upon a time.', narrationIsFallback: false };
    await setupProject({ scene });

    const result = await regenerateAudio(0, scene, baseEls, () => {}, true);
    assert.deepEqual(Object.keys(result).sort(), ['outcome', 'reason']);
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason, /validation/);
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('regenerateImage(withinSerial=true) still throws for a systemic 5xx failure — it must not be swallowed as an ordinary scene failure', async () => {
  installLocalStorageShim();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith('/api/images/generate')) return jsonResponse({ error: 'provider unavailable' }, 502);
    return jsonResponse({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { regenerateImage } = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'workflows.js'));
    const scene = { id: 'scene-1', prompt: 'A hero stands on a cliff.' };
    await setupProject({ scene });

    await assert.rejects(() => regenerateImage(0, scene, baseEls, () => {}, true), /provider unavailable/);
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('regenerateImage(withinSerial=true) throws for a rate-limited (429) response — continuing immediately would just fail identically', async () => {
  installLocalStorageShim();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith('/api/images/generate')) return jsonResponse({ error: 'rate limited' }, 429);
    return jsonResponse({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { regenerateImage } = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'workflows.js'));
    const scene = { id: 'scene-1', prompt: 'A hero stands on a cliff.' };
    await setupProject({ scene });

    await assert.rejects(() => regenerateImage(0, scene, baseEls, () => {}, true), /rate limited/);
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('regenerateImage(withinSerial=true) throws for a network-level failure (no HTTP status at all)', async () => {
  installLocalStorageShim();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith('/api/images/generate')) throw new Error('fetch failed: ECONNREFUSED');
    return jsonResponse({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { regenerateImage } = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'workflows.js'));
    const scene = { id: 'scene-1', prompt: 'A hero stands on a cliff.' };
    await setupProject({ scene });

    await assert.rejects(() => regenerateImage(0, scene, baseEls, () => {}, true), /ECONNREFUSED/);
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('regenerateImage (non-serial, single-scene) still throws on a provider failure — the entity-modal path is unchanged', async () => {
  installLocalStorageShim();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith('/api/images/generate')) return jsonResponse({ error: 'provider unavailable' }, 502);
    return jsonResponse({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { regenerateImage } = await import(path.join(__dirname, '..', 'public', 'js', 'generation', 'workflows.js'));
    const { uiStore } = await import(path.join(__dirname, '..', 'public', 'js', 'core', 'store.js'));
    const scene = { id: 'scene-1', prompt: 'A hero stands on a cliff.' };
    await setupProject({ scene });
    uiStore.set({ operation: null });

    // Non-serial calls resolve the scene from sceneStore by index and pass `scene: null`, matching
    // rendering.js's entity-modal wiring (`regenerateImage(index, null, els, cb)`).
    await assert.rejects(() => regenerateImage(0, null, baseEls, () => {}), /provider unavailable/);
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});
