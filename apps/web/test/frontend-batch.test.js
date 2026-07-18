// Exercises public/modules/batch.js's real start/stop/resume state machine directly (no DOM/fetch
// needed — batchController only touches batchStore/uiStore and whatever generateFn/getScenes the
// caller supplies), covering the pause/resume-with-mixed-outcomes scenario required by the plan:
// scene 1 already complete, scene 2's last attempt failed, scene 3 never attempted — resume must
// retry scene 2 and continue scene 3, and must never re-touch scene 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

async function freshBatchController() {
  // batchStore/uiStore module-level state persists across dynamic imports of the SAME resolved
  // module within one process, so give each test a clean slate rather than relying on import order.
  const { batchController } = await import(path.join(__dirname, '..', 'public', 'modules', 'batch.js'));
  const { batchStore, uiStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
  batchStore.set({
    images: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false },
    audio: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false },
    videos: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false },
  });
  uiStore.set({ operation: null });
  return { batchController, batchStore, uiStore };
}

test('batch pause/resume: a stopped run pauses without touching scenes after the stop point, and resume continues from there', async () => {
  const { batchController, batchStore } = await freshBatchController();
  const scenes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const touched = [];

  const generateFn = async (i, scene) => {
    touched.push(scene.id);
    if (i === 1) batchController.stop('images', null); // request stop while processing scene index 1
    return false; // not skipped
  };

  const finalState = await batchController.start('images', generateFn, () => scenes);
  assert.equal(finalState, 'paused');
  assert.deepEqual(touched, ['a', 'b'], 'the run must stop after the in-flight scene, not silently continue past the stop request');
  assert.equal(batchStore.get().images.currentIndex, 2, 'currentIndex should point at the next untouched scene');

  const resumedTouched = [];
  const resumeGenerateFn = async (i, scene) => { resumedTouched.push(scene.id); return false; };
  const resumedFinalState = await batchController.resume('images', resumeGenerateFn, () => scenes);
  assert.equal(resumedFinalState, 'complete');
  assert.deepEqual(resumedTouched, ['c', 'd'], 'resume must continue only the remaining scenes, never re-touch a and b');
});

test('batch pause/resume with a failed scene: resume retries the failed scene and continues past it without touching the already-complete scene', async () => {
  const { batchController } = await freshBatchController();
  // scene 'a' is already complete (simulated by the caller's generateFn immediately skipping it,
  // as generateMissingOrStale's freshness check would); scene 'b' fails on the first attempt;
  // scene 'c' is untouched pending work.
  const scenes = [{ id: 'a', done: true }, { id: 'b' }, { id: 'c' }];
  let bAttempts = 0;
  const touched = [];

  const firstPassGenerateFn = async (i, scene) => {
    if (scene.done) return true; // already complete: skip, don't touch
    touched.push(scene.id);
    if (scene.id === 'b') { bAttempts += 1; throw new Error('provider error'); }
    return false;
  };

  const finalState = await batchController.start('images', firstPassGenerateFn, () => scenes);
  assert.equal(finalState, 'failed');
  assert.deepEqual(touched, ['b'], 'scene a must never be touched (already complete), and c must not run past the failure');
  assert.equal(bAttempts, 1);

  const resumedTouched = [];
  const resumeGenerateFn = async (i, scene) => {
    if (scene.done) return true;
    resumedTouched.push(scene.id);
    if (scene.id === 'b') { bAttempts += 1; return false; } // succeeds this time
    return false;
  };
  const resumedFinalState = await batchController.resume('images', resumeGenerateFn, () => scenes);
  assert.equal(resumedFinalState, 'complete');
  assert.deepEqual(resumedTouched, ['b', 'c'], 'resume must retry the failed scene b and then continue to c — a stays untouched throughout');
  assert.equal(bAttempts, 2);
});

test('resume is a no-op when the stage was never paused or failed — it never restarts completed work', async () => {
  const { batchController, batchStore } = await freshBatchController();
  batchStore.set({ images: { state: 'complete', currentIndex: 4, generating: false, stopRequested: false } });
  let called = 0;
  const result = await batchController.resume('images', async () => { called += 1; return false; }, () => [{ id: 'a' }]);
  assert.equal(result, undefined);
  assert.equal(called, 0, 'resume must not re-run anything for a stage that already completed');
});

test('regression: getScenes() must return id-bearing objects, not raw id strings — batch.js reads scene.id directly to drive the per-scene loading spinner', async () => {
  // batch.js's own loop does `uiStore.set({ operation: { ..., sceneId: scene.id } })` using
  // `scenes[i]` from whatever getScenes() returned — if that array holds plain strings instead of
  // `{ id }` objects, `scene.id` silently reads `undefined` and no scene card ever shows as loading
  // during a batch run, even though the batch is genuinely in progress. This exercises stages.js's
  // real generateMissingOrStale() (not a hand-rolled fixture) by intercepting batchController.start
  // to capture exactly what it was given, without needing to run the real regenerate pipeline.
  const { batchController } = await import(path.join(__dirname, '..', 'public', 'modules', 'batch.js'));
  const { sceneStore, uiStore, batchStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
  const { generateMissingOrStale } = await import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));

  sceneStore.set({ scenes: [{ id: 'scene-a' }, { id: 'scene-b' }] });
  uiStore.set({ operation: null });
  batchStore.set({ images: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false } });

  const originalStart = batchController.start;
  let capturedScenes = null;
  batchController.start = async (type, generateFn, getScenes) => { capturedScenes = getScenes(); return 'complete'; };
  try {
    await generateMissingOrStale('images', {}, () => {});
  } finally {
    batchController.start = originalStart;
  }

  assert.ok(Array.isArray(capturedScenes) && capturedScenes.length === 2, 'getScenes() should return one entry per scene');
  for (const item of capturedScenes) {
    assert.equal(typeof item, 'object', 'each entry must be an object exposing .id, not a raw id string');
    assert.ok(item && typeof item.id === 'string' && item.id.length > 0, 'each entry must carry a real scene id under .id');
  }
  assert.deepEqual(capturedScenes.map((item) => item.id), ['scene-a', 'scene-b']);
});

// Landing-scene behavior (stages.js's runStageBatch, exercised via generateMissingOrStale): the
// selected-scene anchor must land wherever a run actually stopped, and "actually stopped" is read
// off batchStore's real currentIndex — not guessed — so these mock batchController.start the same
// way the regression test above does, but drive currentIndex to the three states runStageBatch
// must distinguish: committed-then-stopped, stopped-before-committing, and ran-to-completion.

test('landing scene: a Stop that lands after the in-flight scene commits selects the NEXT scene', async () => {
  const { batchController } = await import(path.join(__dirname, '..', 'public', 'modules', 'batch.js'));
  const { sceneStore, uiStore, batchStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
  const { generateMissingOrStale } = await import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));

  sceneStore.set({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  uiStore.set({ operation: null, selectedSceneId: null });
  batchStore.set({ images: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false } });

  const originalStart = batchController.start;
  batchController.start = async (type) => {
    // Scenes a and b committed (currentIndex advanced past them) before the next iteration's
    // top-of-loop check discovered the stop request — the common case.
    batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: 2 } }));
    return 'paused';
  };
  try {
    await generateMissingOrStale('images', {}, () => {});
  } finally {
    batchController.start = originalStart;
  }

  assert.equal(uiStore.get().selectedSceneId, 'c', 'lands on the next untouched scene, not the one that just committed');
});

test('landing scene: a Stop whose in-flight scene never committed (e.g. its request was cancelled) selects that SAME scene again', async () => {
  const { batchController } = await import(path.join(__dirname, '..', 'public', 'modules', 'batch.js'));
  const { sceneStore, uiStore, batchStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
  const { generateMissingOrStale } = await import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));

  sceneStore.set({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  uiStore.set({ operation: null, selectedSceneId: null });
  batchStore.set({ images: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false } });

  const originalStart = batchController.start;
  batchController.start = async (type) => {
    // Scene a committed; scene b was in flight when the stop's job-cancellation made its own call
    // throw — currentIndex never advances past it (batch.js only advances after a resolve).
    batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: 1 } }));
    return 'failed';
  };
  try {
    await generateMissingOrStale('images', {}, () => {});
  } finally {
    batchController.start = originalStart;
  }

  assert.equal(uiStore.get().selectedSceneId, 'b', 'lands back on the scene whose work never committed, so the next Start retries it');
});

test('landing scene: natural completion selects the LAST scene actually processed', async () => {
  const { batchController } = await import(path.join(__dirname, '..', 'public', 'modules', 'batch.js'));
  const { sceneStore, uiStore, batchStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
  const { generateMissingOrStale } = await import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));

  sceneStore.set({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  uiStore.set({ operation: null, selectedSceneId: null });
  batchStore.set({ images: { state: 'idle', currentIndex: 0, generating: false, stopRequested: false } });

  const originalStart = batchController.start;
  batchController.start = async (type, generateFn, getScenes) => {
    batchStore.set((state) => ({ [type]: { ...state[type], currentIndex: getScenes().length } }));
    return 'complete';
  };
  try {
    await generateMissingOrStale('images', {}, () => {});
  } finally {
    batchController.start = originalStart;
  }

  assert.equal(uiStore.get().selectedSceneId, 'd', 'clamps to the last scene actually processed, not past the end of the range');
});
