// The single most important spend-safety test (per plan phase 9): running the Full Production
// preset against narration that would recommend growing the scene count, with
// autoAcceptRecommendations left off (the default), must halt at the scene-count decision with
// ZERO image/audio/video provider calls having occurred. Exercises the real client modules
// (stages.js -> workflows.js -> persistence.js/api.js) with global fetch/localStorage/crypto
// shimmed instead of a browser, since none of this call path touches the DOM directly.
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

test('Full Production preset stops at the scene-count decision — no image/audio/video generate call ever fires before it is resolved', async () => {
  installLocalStorageShim();
  const calledUrls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    calledUrls.push(String(url));
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

    if (String(url).startsWith('/api/storyboard/create-scenes')) {
      return json({ scenes: [{ sceneNumber: 1, title: 'Scene 1', scriptFragment: 'A short opening.', beat: 'Someone acts.', prompt: 'Someone acts, clear pose.' }] });
    }
    if (String(url).startsWith('/api/storyboard/generate-dialogue')) {
      // Deliberately long narration so suggestSceneCountFromNarration recommends MORE scenes than
      // the single-scene skeleton above — this is what must trigger the scene-count decision stop.
      const longNarration = 'A long narrated passage full of pacing and detail. '.repeat(20);
      return json({ scenesDialogue: [{ sceneNumber: 1, narrationText: longNarration, usedFallback: false }], usedFallback: false, warning: '' });
    }
    if (String(url).startsWith('/api/images/generate') || String(url).startsWith('/api/audio/generate') || String(url).startsWith('/api/videos/generate')) {
      throw new Error(`SPEND-SAFETY VIOLATION: ${url} must never be called before the scene-count decision is resolved`);
    }
    // Any other call (project sync/create, jobs listing, etc.) gets a permissive generic response —
    // this test is only asserting about the media-generation endpoints above.
    return json({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { projectStore, sceneStore, uiStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
    const { runCreateStoryFlow } = await import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));

    const record = { id: 'spend-gate-test-project', title: 'Spend Gate Test', revision: 1, scenes: [], enrich: true };
    projectStore.set({ currentId: record.id, storyboards: [record] });
    sceneStore.set({ scenes: [] });
    uiStore.set({ operation: null });

    const els = {
      scriptText: { value: 'A short opening for the story.' },
      sceneCount: { value: '1' },
      styleSelect: { value: 'basic-cartoon' },
      commonPromptText: { value: '' },
      textProvider: { value: 'gemini' },
      imageProvider: { value: 'gemini' },
      fallbackPolicy: { value: 'local' },
      enrichNarration: { checked: true },
    };

    const result = await runCreateStoryFlow('full-production', els, () => {}, { autoAcceptRecommendations: false });

    assert.equal(result.stoppedAt, 'sceneCountDecision', 'the flow must stop exactly at the scene-count decision, not proceed past it');
    const mediaCalls = calledUrls.filter((url) => /^\/api\/(images|audio|videos)\/generate/.test(url));
    assert.equal(mediaCalls.length, 0, 'no image/audio/video generation call may occur before the user resolves the scene-count decision');
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});
