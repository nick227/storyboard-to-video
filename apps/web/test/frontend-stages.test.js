// Exercises the pure derivation functions in public/modules/stages.js and
// public/modules/scene-count.js directly via dynamic import — these are browser ES modules with no
// top-level DOM/network access, so they load fine under plain Node as long as no function that
// touches document/localStorage/fetch is actually invoked (computeStaleness/computeStageStatus/
// getPrimaryAction/suggestSceneCountFromNarration never do).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stagesPromise = import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));
const sceneCountPromise = import(path.join(__dirname, '..', 'public', 'modules', 'scene-count.js'));
const storePromise = import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));

function scene(overrides = {}) {
  return {
    id: 's1', beat: 'Mara opens the door.', prompt: 'Mara opens the door, hallway beyond.',
    promptGeneratedFromBeat: 'Mara opens the door.', promptGeneratedFromNarration: null,
    narrationText: '', versions: [], activeVersionIndex: 0,
    audioVersions: [], activeAudioVersionIndex: 0,
    videoVersions: [], activeVideoVersionIndex: 0,
    ...overrides,
  };
}

test('computeStaleness: prompt is stale when beat changed since the prompt was generated', async () => {
  const { computeStaleness } = await stagesPromise;
  const fresh = scene();
  assert.equal(computeStaleness(fresh).promptStale, false);
  const staleBeat = scene({ beat: 'Mara kicks the door open.' });
  assert.equal(computeStaleness(staleBeat).promptStale, true);
});

test('computeStaleness: prompt is stale when narration changed and the prompt was narration-sourced', async () => {
  const { computeStaleness } = await stagesPromise;
  const narrationSourced = scene({ narrationText: 'Mara steps in.', promptGeneratedFromNarration: 'Mara steps in.' });
  assert.equal(computeStaleness(narrationSourced).promptStale, false);
  const changedNarration = scene({ narrationText: 'Mara bursts in, breathless.', promptGeneratedFromNarration: 'Mara steps in.' });
  assert.equal(computeStaleness(changedNarration).promptStale, true);
});

test('computeStaleness: image is stale when its stored generation prompt no longer matches the scene prompt', async () => {
  const { computeStaleness } = await stagesPromise;
  // `scenePrompt` (the raw scene-level prompt) is what staleness compares against — never `prompt`,
  // which is the full composed provider prompt (style + common + scene + extra) and would never
  // equal `scene.prompt` alone, even for a freshly-generated image (this was a real bug).
  const fresh = scene({ versions: [{ path: '/a.png', prompt: 'Ink style.\n\nMara opens the door, hallway beyond.', scenePrompt: 'Mara opens the door, hallway beyond.' }], activeVersionIndex: 0 });
  assert.equal(computeStaleness(fresh).imageStale, false);
  const stale = scene({ prompt: 'A completely different prompt.', versions: [{ path: '/a.png', prompt: 'Ink style.\n\nMara opens the door, hallway beyond.', scenePrompt: 'Mara opens the door, hallway beyond.' }], activeVersionIndex: 0 });
  assert.equal(computeStaleness(stale).imageStale, true);
});

test('computeStaleness: audio is stale when its stored narration snapshot no longer matches the scene narration', async () => {
  const { computeStaleness } = await stagesPromise;
  // `provider: 'stub'` matches voiceStore's default `audioProvider` so this fixture isolates the
  // narration comparison — otherwise it would also read as stale via the provider check below.
  const fresh = scene({ narrationText: 'Mara steps in.', audioVersions: [{ path: '/a.mp3', narrationText: 'Mara steps in.', provider: 'stub' }], activeAudioVersionIndex: 0 });
  assert.equal(computeStaleness(fresh).audioStale, false);
  const stale = scene({ narrationText: 'Mara bursts in.', audioVersions: [{ path: '/a.mp3', narrationText: 'Mara steps in.', provider: 'stub' }], activeAudioVersionIndex: 0 });
  assert.equal(computeStaleness(stale).audioStale, true);
});

test('computeStaleness: audio is stale when its stored provider no longer matches the currently selected voice provider', async () => {
  const { computeStaleness } = await stagesPromise;
  const { voiceStore } = await storePromise;
  const fresh = scene({ narrationText: 'Mara steps in.', audioVersions: [{ path: '/a.mp3', narrationText: 'Mara steps in.', provider: 'stub' }], activeAudioVersionIndex: 0 });
  assert.equal(computeStaleness(fresh).audioStale, false);
  voiceStore.set({ audioProvider: 'spark' });
  try {
    assert.equal(computeStaleness(fresh).audioStale, true);
  } finally {
    voiceStore.set({ audioProvider: 'stub' });
  }
});

test('computeStaleness: video is stale when its source image no longer matches the active image version', async () => {
  const { computeStaleness } = await stagesPromise;
  const fresh = scene({
    versions: [{ path: '/a.png', prompt: 'x' }], activeVersionIndex: 0,
    videoVersions: [{ path: '/a.mp4', sourceImagePath: '/a.png' }], activeVideoVersionIndex: 0,
  });
  assert.equal(computeStaleness(fresh).videoStale, false);
  const stale = scene({
    versions: [{ path: '/b.png', prompt: 'x' }], activeVersionIndex: 0,
    videoVersions: [{ path: '/a.mp4', sourceImagePath: '/a.png' }], activeVideoVersionIndex: 0,
  });
  assert.equal(computeStaleness(stale).videoStale, true);
});

test('computeStageStatus: distinguishes missing, stale, done, and failed as separate counts, not one collapsed number', async () => {
  const { computeStageStatus } = await stagesPromise;
  const scenes = [
    scene({ id: 'done', versions: [{ path: '/a.png', prompt: 'Ink style.\n\nMara opens the door, hallway beyond.', scenePrompt: 'Mara opens the door, hallway beyond.' }], activeVersionIndex: 0 }),
    scene({ id: 'stale', prompt: 'changed prompt', versions: [{ path: '/b.png', prompt: 'Ink style.\n\nold prompt', scenePrompt: 'old prompt' }], activeVersionIndex: 0 }),
    scene({ id: 'missing' }),
    scene({ id: 'failed' }),
  ];
  const batchState = { images: { state: 'idle', generating: false }, audio: { state: 'idle' }, videos: { state: 'idle' } };
  const recentJobs = [{ type: 'image', sceneId: 'failed', status: 'failed', createdAt: new Date().toISOString() }];
  const status = computeStageStatus(scenes, batchState, null, recentJobs, {});
  assert.equal(status.images.done, 1);
  assert.equal(status.images.stale, 1);
  assert.equal(status.images.missing, 1);
  assert.equal(status.images.failed, 1);
  assert.equal(status.images.total, 4);
});

test('computeStageStatus: failed status is derived from durable job history, not only in-memory batch state (survives a simulated reload)', async () => {
  const { computeStageStatus } = await stagesPromise;
  const scenes = [scene({ id: 'failed-scene' })];
  // Simulates a fresh page load: batchState is back to its idle default (in-memory state lost),
  // but the job history is durable and still reports the failure.
  const freshBatchState = { images: { state: 'idle', generating: false }, audio: { state: 'idle' }, videos: { state: 'idle' } };
  const recentJobs = [{ type: 'image', sceneId: 'failed-scene', status: 'failed', createdAt: new Date().toISOString() }];
  const status = computeStageStatus(scenes, freshBatchState, null, recentJobs, {});
  assert.equal(status.images.failed, 1, 'failed status must be recoverable from job history alone after a reload');
});

test('computeStageStatus: paused stage status survives a simulated reload via persisted stageRuns, not just in-memory batchState', async () => {
  const { computeStageStatus } = await stagesPromise;
  const scenes = [scene({ id: 'a' })];
  const freshBatchState = { images: { state: 'idle', generating: false }, audio: { state: 'idle' }, videos: { state: 'idle' } };
  const status = computeStageStatus(scenes, freshBatchState, null, [], { images: 'paused' });
  assert.equal(status.images.paused, true);
});

test('getPrimaryAction: always the next useful step — Plan Story before anything else, Resume overrides everything when paused', async () => {
  const { getPrimaryAction } = await stagesPromise;
  const empty = { planning: { total: 0, missing: 0 }, images: { paused: false, missing: 0, stale: 0 }, audio: { paused: false, missing: 0, stale: 0 }, video: { paused: false, missing: 0, stale: 0 } };
  assert.equal(getPrimaryAction(empty).kind, 'plan');

  const planned = { planning: { total: 3, missing: 0 }, images: { paused: false, missing: 3, stale: 0 }, audio: { paused: false, missing: 3, stale: 0 }, video: { paused: false, missing: 3, stale: 0 } };
  const imagesAction = getPrimaryAction(planned);
  assert.equal(imagesAction.stage, 'images');

  const imagesDone = { planning: { total: 3, missing: 0 }, images: { paused: false, missing: 0, stale: 0 }, audio: { paused: false, missing: 3, stale: 0 }, video: { paused: false, missing: 3, stale: 0 } };
  assert.equal(getPrimaryAction(imagesDone).stage, 'audio');

  const paused = { planning: { total: 3, missing: 0 }, images: { paused: true, missing: 1, stale: 0 }, audio: { paused: false, missing: 3, stale: 0 }, video: { paused: false, missing: 3, stale: 0 } };
  assert.equal(getPrimaryAction(paused).kind, 'resume', 'a paused stage must always surface Resume as the primary action');

  const allDone = { planning: { total: 3, missing: 0 }, images: { paused: false, missing: 0, stale: 0 }, audio: { paused: false, missing: 0, stale: 0 }, video: { paused: false, missing: 0, stale: 0 } };
  assert.equal(getPrimaryAction(allDone).kind, 'idle');
});

test('suggestSceneCountFromNarration: deterministic for identical input', async () => {
  const { suggestSceneCountFromNarration } = await sceneCountPromise;
  const scenes = Array.from({ length: 5 }, (_, i) => ({ narrationText: `Scene ${i} has some narration words in it for pacing purposes.` }));
  const first = suggestSceneCountFromNarration(scenes);
  const second = suggestSceneCountFromNarration(scenes);
  assert.equal(first, second, 'identical narration/config must always produce the identical recommended count');
});

test('suggestSceneCountFromNarration: never recommends fewer scenes than currently exist', async () => {
  const { suggestSceneCountFromNarration } = await sceneCountPromise;
  const scenes = Array.from({ length: 10 }, () => ({ narrationText: 'Short.' }));
  const recommended = suggestSceneCountFromNarration(scenes);
  assert.ok(recommended >= scenes.length, 'recommendation must never shrink below the current scene count');
});

test('suggestSceneCountFromNarration: grows with narration length but stays bounded, not an uncontrolled multiplier', async () => {
  const { suggestSceneCountFromNarration } = await sceneCountPromise;
  const modest = Array.from({ length: 3 }, () => ({ narrationText: 'A short sentence of narration for this scene.' }));
  const verbose = Array.from({ length: 3 }, () => ({ narrationText: 'A much longer passage of narration '.repeat(6) }));
  const modestCount = suggestSceneCountFromNarration(modest);
  const verboseCount = suggestSceneCountFromNarration(verbose);
  assert.ok(verboseCount >= modestCount, 'richer narration may recommend more scenes');
  assert.ok(verboseCount <= 50, 'recommendation must stay within the hard scene-count cap, never explode unbounded');
});

test('getStageSelection: a brand-new project (no scenes yet) selects Planning but not Images/Audio/Video — there is nothing for them to do yet', async () => {
  const { getStageSelection } = await stagesPromise;
  const empty = { planning: { total: 0, missing: 0, stale: 0, failed: 0 }, images: { total: 0, missing: 0, stale: 0, failed: 0 }, audio: { total: 0, missing: 0, stale: 0, failed: 0 }, video: { total: 0, missing: 0, stale: 0, failed: 0 } };
  const selection = getStageSelection(empty);
  assert.equal(selection.planning, true, 'an empty project always needs Planning');
  assert.equal(selection.images, false);
  assert.equal(selection.audio, false);
  assert.equal(selection.video, false);
});

test('getStageSelection: defaults to selected for any stage with missing/stale/failed work, unselected when already up to date', async () => {
  const { getStageSelection } = await stagesPromise;
  const status = {
    planning: { total: 5, missing: 0, stale: 0, failed: 0 }, // fully planned, nothing to do
    images: { total: 5, missing: 0, stale: 2, failed: 0 }, // stale — should default-select
    audio: { total: 5, missing: 5, stale: 0, failed: 0 }, // missing — should default-select
    video: { total: 5, missing: 0, stale: 0, failed: 0 }, // up to date — should NOT default-select
  };
  const selection = getStageSelection(status);
  assert.equal(selection.planning, false, 'a fully up-to-date Planning box has nothing to select');
  assert.equal(selection.images, true);
  assert.equal(selection.audio, true);
  assert.equal(selection.video, false);
});

test('toggleStageSelection: a box is never permanently disabled — the user can select or deselect ANY stage, even one with no detected work', async () => {
  const { getStageSelection, toggleStageSelection } = await stagesPromise;
  const status = {
    planning: { total: 5, missing: 0, stale: 0, failed: 0 },
    images: { total: 5, missing: 0, stale: 3, failed: 0 },
    audio: { total: 5, missing: 0, stale: 0, failed: 0 },
    video: { total: 5, missing: 0, stale: 0, failed: 0 },
  };
  assert.equal(getStageSelection(status).images, true, 'images starts selected (it has stale work)');
  toggleStageSelection('images', status);
  assert.equal(getStageSelection(status).images, false, 'the user must be able to deselect it');
  toggleStageSelection('images', status);
  assert.equal(getStageSelection(status).images, true, 'and re-select it again');

  // Our staleness tracking is a heuristic (per-scene field drift) and can't see everything — e.g. a
  // server-side prompt-logic change. Permanently disabling a box that "looks" up to date would block
  // a legitimate forced re-run, so toggling must always work, never no-op.
  assert.equal(getStageSelection(status).audio, false, 'audio starts unselected — no detected work');
  toggleStageSelection('audio', status);
  assert.equal(getStageSelection(status).audio, true, 'the user must be able to select it anyway, to force a run');
  toggleStageSelection('audio', status);
  assert.equal(getStageSelection(status).audio, false, 'and deselect it again');
});

test('hasPlanningChanges: detects changes when script or settings differ from lastPromptInputs', async () => {
  const { hasPlanningChanges } = await stagesPromise;
  const scenes = [scene()];
  
  const recordNoChanges = {
    scriptText: 'test script',
    commonPromptText: 'common',
    styleId: 'style',
    textProvider: 'gemini',
    enrich: true,
    sceneCountMode: 'manual',
    sceneCount: 1,
    lastPromptInputs: {
      scriptText: 'test script',
      commonPromptText: 'common',
      styleId: 'style',
      textProvider: 'gemini',
      enrich: true,
      sceneCount: 1,
    }
  };
  assert.equal(hasPlanningChanges(scenes, recordNoChanges), false, 'no changes should be detected when inputs match');

  const recordScriptChanged = {
    ...recordNoChanges,
    scriptText: 'new script text',
  };
  assert.equal(hasPlanningChanges(scenes, recordScriptChanged), true, 'should detect script changes');

  const recordProviderChanged = {
    ...recordNoChanges,
    textProvider: 'openai',
  };
  assert.equal(hasPlanningChanges(scenes, recordProviderChanged), true, 'should detect text provider changes');

  const recordStyleChanged = {
    ...recordNoChanges,
    styleId: 'new-style',
  };
  assert.equal(hasPlanningChanges(scenes, recordStyleChanged), true, 'should detect style changes');

  const recordCountChanged = {
    ...recordNoChanges,
    sceneCount: 5,
  };
  assert.equal(hasPlanningChanges(scenes, recordCountChanged), true, 'should detect scene count changes');

  assert.equal(hasPlanningChanges([], recordNoChanges), true, 'empty scenes should always indicate changes');
});

test('stageHasActionableWork: returns true for planning when hasChanges is true', async () => {
  const { stageHasActionableWork } = await stagesPromise;
  const statusNoChanges = { total: 1, missing: 0, stale: 0, failed: 0, hasChanges: false };
  assert.equal(stageHasActionableWork('planning', statusNoChanges), false, 'should have no actionable work if no changes and not missing/stale');

  const statusWithChanges = { total: 1, missing: 0, stale: 0, failed: 0, hasChanges: true };
  assert.equal(stageHasActionableWork('planning', statusWithChanges), true, 'should have actionable work when hasChanges is true');
});

test('computeStageStatus: sets planning.hasChanges based on hasPlanningChanges', async () => {
  const { computeStageStatus } = await stagesPromise;
  const { projectStore } = await import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
  
  const record = {
    id: 'p1',
    scriptText: 'new script text',
    commonPromptText: 'common',
    styleId: 'style',
    textProvider: 'gemini',
    enrich: true,
    sceneCountMode: 'manual',
    sceneCount: 1,
    lastPromptInputs: {
      scriptText: 'old script text',
      commonPromptText: 'common',
      styleId: 'style',
      textProvider: 'gemini',
      enrich: true,
      sceneCount: 1,
    }
  };

  projectStore.set({
    currentId: 'p1',
    storyboards: [record]
  });

  const scenes = [scene()];
  const batchState = { images: { state: 'idle' }, audio: { state: 'idle' }, videos: { state: 'idle' } };
  const status = computeStageStatus(scenes, batchState, null, [], {});
  assert.equal(status.planning.hasChanges, true, 'planning.hasChanges should be true when scriptText changed');
  
  // Cleanup
  projectStore.set({ currentId: null, storyboards: [] });
});
