// The single most important spend-safety test (per plan phase 9): running the Full Production
// preset must never let an image/audio/video provider call fire before shot planning (narration +
// shot list, now one atomic step — see shot-planning.service.js) has actually resolved. Planning no
// longer pauses for a mid-flow user decision (there is nothing left to decide: shot count is just
// how many shots planning returned), so the property this test protects is now "media generation
// never starts while planning is still in flight or after it failed", not "the flow halts at a
// specific named stop". Exercises the real client modules (stages.js -> workflows.js ->
// persistence.js/api.js) with global fetch/localStorage/crypto shimmed instead of a browser, since
// none of this call path touches the DOM directly.
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

test('Full Production preset never starts image/audio/video generation when shot planning fails', async () => {
  installLocalStorageShim();
  const calledUrls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    calledUrls.push(String(url));
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

    if (String(url).startsWith('/api/storyboard/plan-shots')) {
      return json({ error: 'provider unavailable' }, 502);
    }
    if (String(url).startsWith('/api/images/generate') || String(url).startsWith('/api/audio/generate') || String(url).startsWith('/api/videos/generate')) {
      throw new Error(`SPEND-SAFETY VIOLATION: ${url} must never be called after shot planning failed`);
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
      styleSelect: { value: 'basic-cartoon' },
      commonPromptText: { value: '' },
      textProvider: { value: 'gemini' },
      imageProvider: { value: 'gemini' },
      fallbackPolicy: { value: 'fail' },
      enrichNarration: { checked: true },
    };

    const result = await runCreateStoryFlow('full-production', els, () => {});

    assert.equal(result.stoppedAt, 'failed', 'the flow must report a stop, not silently proceed, when shot planning fails');
    const mediaCalls = calledUrls.filter((url) => /^\/api\/(images|audio|videos)\/generate/.test(url));
    assert.equal(mediaCalls.length, 0, 'no image/audio/video generation call may occur after shot planning failed');
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('Planning stage lands on however many shots plan-shots actually returns, with no separate scene-count or reconciliation call', async () => {
  installLocalStorageShim();
  const calledUrls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    calledUrls.push(String(url));
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

    if (String(url).startsWith('/api/storyboard/plan-shots')) {
      // Five shots back from one call -- nothing upstream requested five, and nothing downstream
      // needs to reconcile that against a guess.
      const scenes = Array.from({ length: 5 }, (_, i) => ({
        sceneNumber: i + 1, title: `Scene ${i + 1}`, scriptFragment: `Shot ${i + 1} narration.`,
        narrationText: `Shot ${i + 1} narration.`, beat: `Action ${i + 1}.`, prompt: `Prompt ${i + 1}.`,
      }));
      return json({ scenes, narrationText: 'Full narration.', usedFallback: false, warning: '' });
    }
    if (String(url).startsWith('/api/images/generate') || String(url).startsWith('/api/audio/generate') || String(url).startsWith('/api/videos/generate')) {
      return json({ ok: true });
    }
    return json({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { projectStore, sceneStore, uiStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
    const { runPlanning } = await import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));

    const record = { id: 'plan-shots-test-project', title: 'Plan Shots Test', revision: 1, scenes: [], enrich: true };
    projectStore.set({ currentId: record.id, storyboards: [record] });
    sceneStore.set({ scenes: [] });
    uiStore.set({ operation: null });

    const els = {
      scriptText: { value: 'A story with several distinct beats.' },
      styleSelect: { value: 'basic-cartoon' },
      commonPromptText: { value: '' },
      textProvider: { value: 'gemini' },
      imageProvider: { value: 'gemini' },
      fallbackPolicy: { value: 'fail' },
      enrichNarration: { checked: true },
    };

    const result = await runPlanning(els, () => {});

    assert.equal(result.stoppedAt, null, 'planning should run straight through with nothing to decide');
    assert.equal(result.finalCount, 5, 'the final count is simply how many shots the call returned');
    assert.equal(sceneStore.get().scenes.length, 5);
    assert.equal(calledUrls.filter((url) => url.startsWith('/api/storyboard/plan-shots')).length, 1, 'exactly one planning call, no follow-up recount/reconcile request');
    assert.equal(calledUrls.some((url) => url.includes('create-scenes') || url.includes('generate-prompts') || url.includes('generate-dialogue')), false, 'the old multi-step scene-count flow must not be invoked');
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('replanStory reuses plan-shots and requests no target count -- the fresh plan\'s own shot count is authoritative', async () => {
  installLocalStorageShim();
  const calledUrls = [];
  const planShotsBodies = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    calledUrls.push(String(url));
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

    if (String(url).startsWith('/api/storyboard/plan-shots')) {
      if (options?.body) planShotsBodies.push(JSON.parse(options.body));
      // A different count than whatever the project started with -- replan must accept this as-is,
      // not reconcile it against a prior count or a requested target.
      const scenes = Array.from({ length: 3 }, (_, i) => ({
        sceneNumber: i + 1, title: `Scene ${i + 1}`, scriptFragment: `Shot ${i + 1}.`,
        narrationText: `Shot ${i + 1}.`, beat: `Action ${i + 1}.`, prompt: `Prompt ${i + 1}.`,
      }));
      return json({ scenes, narrationText: 'Full narration.', usedFallback: false, warning: '' });
    }
    if (String(url).includes('create-scenes') || String(url).includes('generate-prompts') || String(url).includes('generate-dialogue')) {
      throw new Error(`${url} must never be called by replanStory -- it should use plan-shots exclusively`);
    }
    return json({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1, removed: [] });
  };

  try {
    const { projectStore, sceneStore, uiStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
    const { replanStory } = await import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));

    const record = { id: 'replan-test-project', title: 'Replan Test', revision: 1, scenes: [{ id: 'old-1' }, { id: 'old-2' }], enrich: true };
    projectStore.set({ currentId: record.id, storyboards: [record] });
    sceneStore.set({ scenes: record.scenes });
    uiStore.set({ operation: null });

    const els = {
      scriptText: { value: 'A rewritten story with a different shape.' },
      styleSelect: { value: 'basic-cartoon' },
      commonPromptText: { value: '' },
      textProvider: { value: 'gemini' },
      imageProvider: { value: 'gemini' },
      fallbackPolicy: { value: 'fail' },
      enrichNarration: { checked: true },
    };

    await replanStory(els, () => {});

    assert.equal(calledUrls.filter((url) => url.startsWith('/api/storyboard/plan-shots')).length, 1, 'replan should call plan-shots exactly once');
    assert.equal('sceneCount' in planShotsBodies[0], false, 'the plan-shots request body must not carry a requested/target shot count');
    assert.equal(sceneStore.get().scenes.length, 3, 'the resulting shot count is whatever the fresh plan produced, not the old count or a request');
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});

test('the shot-limit select threads maxShots into the plan-shots request as a ceiling, and "Unlimited" omits it entirely', async () => {
  installLocalStorageShim();
  const planShotsBodies = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (String(url).startsWith('/api/storyboard/plan-shots')) {
      if (options?.body) planShotsBodies.push(JSON.parse(options.body));
      return json({ scenes: [{ sceneNumber: 1, title: 'Scene 1', scriptFragment: 'One shot.', narrationText: 'One shot.', beat: 'Action.', prompt: 'Prompt.' }], narrationText: 'One shot.', usedFallback: false, warning: '' });
    }
    return json({ ok: true, project: { revision: 1, scenes: [] }, jobs: [], revision: 1 });
  };

  try {
    const { projectStore, sceneStore, uiStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
    const { planShots } = await import(path.join(__dirname, '..', 'public', 'modules', 'workflows.js'));

    const record = { id: 'shot-limit-test-project', title: 'Shot Limit Test', revision: 1, scenes: [], enrich: true };
    projectStore.set({ currentId: record.id, storyboards: [record] });

    const baseEls = {
      scriptText: { value: 'A story.' },
      styleSelect: { value: 'basic-cartoon' },
      commonPromptText: { value: '' },
      textProvider: { value: 'gemini' },
      imageProvider: { value: 'gemini' },
      fallbackPolicy: { value: 'fail' },
      enrichNarration: { checked: true },
    };

    sceneStore.set({ scenes: [] }); uiStore.set({ operation: null });
    await planShots({ ...baseEls, settingsShotLimitSelect: { value: '25' } }, () => {});
    assert.equal(planShotsBodies[0].maxShots, 25, 'a selected limit should be sent as maxShots');

    sceneStore.set({ scenes: [] }); uiStore.set({ operation: null });
    await planShots({ ...baseEls, settingsShotLimitSelect: { value: '' } }, () => {});
    assert.equal('maxShots' in planShotsBodies[1], false, '"Unlimited" (empty value) should omit maxShots entirely, not send a falsy value');
  } finally {
    global.fetch = originalFetch;
    delete global.localStorage;
  }
});
