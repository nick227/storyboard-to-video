// Exercises the pure derivation functions in public/modules/stages.js and
// public/modules/scene-count.js directly via dynamic import — these are browser ES modules with no
// top-level DOM/network access, so they load fine under plain Node as long as no function that
// touches document/localStorage/fetch is actually invoked (computeStaleness/computeStageStatus/
// suggestSceneCountFromNarration never do).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stagesPromise = import(path.join(__dirname, '..', 'public', 'modules', 'stages.js'));
const sceneCountPromise = import(path.join(__dirname, '..', 'public', 'modules', 'scene-count.js'));
const storePromise = import(path.join(__dirname, '..', 'public', 'modules', 'store.js'));
const manifestPromise = import(path.join(__dirname, '..', 'public', 'modules', 'generation-manifest.js'));

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

test('computeStaleness: image is not marked stale by provider alone when the stored version predates the provider field', async () => {
  const { computeStaleness } = await stagesPromise;
  const { projectStore } = await storePromise;
  // Legacy version with no `provider` key at all — must not be mass-marked stale just because a
  // provider is now selected; only the scenePrompt comparison applies to it.
  const legacy = scene({ versions: [{ path: '/a.png', scenePrompt: 'Mara opens the door, hallway beyond.' }], activeVersionIndex: 0 });
  projectStore.set({ storyboards: [{ id: 'p1', imageProvider: 'dezgo' }], currentId: 'p1' });
  try {
    assert.equal(computeStaleness(legacy).imageStale, false);
  } finally {
    projectStore.set({ storyboards: [], currentId: null });
  }
});

test('computeStaleness: image is stale when its stored provider no longer matches the currently selected image provider', async () => {
  const { computeStaleness } = await stagesPromise;
  const { projectStore } = await storePromise;
  const fresh = scene({ versions: [{ path: '/a.png', scenePrompt: 'Mara opens the door, hallway beyond.', provider: 'gemini' }], activeVersionIndex: 0 });
  projectStore.set({ storyboards: [{ id: 'p1', imageProvider: 'gemini' }], currentId: 'p1' });
  try {
    assert.equal(computeStaleness(fresh).imageStale, false);
    projectStore.set({ storyboards: [{ id: 'p1', imageProvider: 'dezgo' }], currentId: 'p1' });
    assert.equal(computeStaleness(fresh).imageStale, true);
  } finally {
    projectStore.set({ storyboards: [], currentId: null });
  }
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

test('computeStaleness: canonical shots[0] pairs video provenance with that shot active image', async () => {
  const { computeStaleness } = await stagesPromise;
  const canonical = scene({
    prompt: undefined,
    versions: undefined,
    activeVersionIndex: undefined,
    videoVersions: undefined,
    activeVideoVersionIndex: undefined,
    shots: [{
      prompt: 'Mara opens the door, hallway beyond.',
      versions: [{ path: '/active.png', scenePrompt: 'Mara opens the door, hallway beyond.' }],
      activeVersionIndex: 0,
      videoVersions: [{ path: '/active.mp4', sourceImagePath: '/active.png' }],
      activeVideoVersionIndex: 0,
    }],
  });
  assert.equal(computeStaleness(canonical).videoStale, false);
  canonical.shots[0].activeVersionIndex = 1;
  canonical.shots[0].versions.push({ path: '/new-active.png', scenePrompt: 'Mara opens the door, hallway beyond.' });
  assert.equal(computeStaleness(canonical).videoStale, true);
});

test('computeStaleness: manifest hash detects image inputs beyond the legacy prompt/provider fields', async () => {
  const { computeStaleness } = await stagesPromise;
  const { projectStore, generationStore } = await storePromise;
  const { hashCanonical } = await manifestPromise;
  const inputs = {
    modality: 'image', operation: 'image.generate',
    prompt: { composed: 'Ink style.\n\nMara opens the door, hallway beyond.', scene: 'Mara opens the door, hallway beyond.', style: 'Ink style.', common: '', extra: '' },
    provider: { name: 'gemini', model: 'gemini-test' },
    references: [], settings: { temperature: 0.7 }, style: { id: 'ink' },
  };
  const imageVersion = {
    path: '/active.png', scenePrompt: inputs.prompt.scene, provider: 'gemini',
    output: { requested: { aspectRatio: '1:1', resolutionTier: 'standard', quality: 'medium' } },
    manifest: { schemaVersion: 1, inputs, manifestHash: hashCanonical(inputs) },
  };
  const canonical = scene({ shots: [{
    prompt: inputs.prompt.scene, versions: [imageVersion], activeVersionIndex: 0,
    videoVersions: [], activeVideoVersionIndex: 0,
  }] });
  projectStore.set({ storyboards: [{ id: 'p1', styleId: 'ink', commonPromptText: 'Ink style.', imageProvider: 'gemini', videoMotionIntensity: 'medium', mediaSettings: { image: { resolutionTier: 'standard', quality: 'medium' } } }], currentId: 'p1' });
  generationStore.set({ styles: [{ id: 'ink', promptText: 'Ink style.' }], styleReferences: { characters: [], world: [] }, styleReferencesStyleId: 'ink' });
  try {
    assert.equal(computeStaleness(canonical).imageStale, false);
    projectStore.set({ storyboards: [{ id: 'p1', styleId: 'ink', commonPromptText: 'Ink style.', imageProvider: 'gemini', videoMotionIntensity: 'medium', mediaSettings: { image: { resolutionTier: 'high', quality: 'medium' } } }], currentId: 'p1' });
    assert.equal(computeStaleness(canonical).imageStale, true, 'resolution changes apply even when aspect ratio is inherited');
    projectStore.set({ storyboards: [{ id: 'p1', styleId: 'ink', commonPromptText: 'Ink style. Add red accents.', imageProvider: 'gemini', videoMotionIntensity: 'medium' }], currentId: 'p1' });
    assert.equal(computeStaleness(canonical).imageStale, true, 'common direction is part of the manifest hash');
  } finally {
    projectStore.set({ storyboards: [], currentId: null });
    generationStore.set({ styles: [], styleReferences: { characters: [], world: [] }, styleReferencesStyleId: null });
  }
});

test('computeStaleness: video manifest hash includes motion settings and the active start frame', async () => {
  const { computeStaleness } = await stagesPromise;
  const { projectStore, generationStore } = await storePromise;
  const { hashCanonical } = await manifestPromise;
  const videoInputs = {
    modality: 'video', operation: 'video.generate',
    prompt: { composed: 'Video prompt', scene: 'Mara at the door.', beat: 'Mara opens the door.', style: 'Ink style.', common: '', motion: '' },
    provider: { name: 'ltx', model: 'ltx-test' },
    settings: { motionIntensity: 'medium', seed: 42 }, style: { id: 'ink' },
    sourceAssets: [
      { role: 'start_frame', path: '/active.png', sha256: 'start-hash', consumed: true },
      { role: 'end_frame', path: '/end.png', sha256: 'end-hash', consumed: false },
    ],
  };
  const canonical = scene({
    beat: 'Mara opens the door.',
    shots: [{
      prompt: 'Mara at the door.',
      versions: [{ path: '/active.png', scenePrompt: 'Mara at the door.' }, { path: '/end.png' }], activeVersionIndex: 0,
      startFrame: '/active.png', endFrame: '/end.png',
      videoKeyframeSelection: { version: 1, source: 'video_generation_confirmation', startFrame: '/active.png', endFrame: '/end.png', confirmedAt: '2026-07-20T00:00:00.000Z' },
      videoVersions: [{
        path: '/active.mp4', sourceImagePath: '/active.png',
        manifest: { schemaVersion: 1, inputs: videoInputs, manifestHash: hashCanonical(videoInputs) },
      }], activeVideoVersionIndex: 0,
    }],
  });
  projectStore.set({ storyboards: [{ id: 'p1', styleId: 'ink', commonPromptText: 'Ink style.', imageProvider: 'gemini', videoMotionIntensity: 'medium' }], currentId: 'p1' });
  generationStore.set({ styles: [{ id: 'ink', promptText: 'Ink style.' }] });
  try {
    assert.equal(computeStaleness(canonical).videoStale, false);
    canonical.shots[0].endFrame = '/different-end.png';
    canonical.shots[0].videoKeyframeSelection.endFrame = '/different-end.png';
    assert.equal(computeStaleness(canonical).videoStale, true, 'changing the selected end frame changes the manifest hash');
    canonical.shots[0].endFrame = '/end.png';
    canonical.shots[0].videoKeyframeSelection.endFrame = '/end.png';
    canonical.shots[0].startFrame = '/different-start.png';
    canonical.shots[0].videoKeyframeSelection.startFrame = '/different-start.png';
    assert.equal(computeStaleness(canonical).videoStale, true, 'changing the selected start frame changes the manifest hash');
    canonical.shots[0].startFrame = '/active.png';
    canonical.shots[0].videoKeyframeSelection.startFrame = '/active.png';
    projectStore.set({ storyboards: [{ id: 'p1', styleId: 'ink', commonPromptText: 'Ink style.', imageProvider: 'gemini', videoMotionIntensity: 'high' }], currentId: 'p1' });
    assert.equal(computeStaleness(canonical).videoStale, true);
  } finally {
    projectStore.set({ storyboards: [], currentId: null });
    generationStore.set({ styles: [] });
  }
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

test('buildLatestJobsByScene: exposes the same per-scene job lookup mediaTally uses internally, for the per-scene status-icon failed state', async () => {
  const { buildLatestJobsByScene } = await stagesPromise;
  const recentJobs = [
    { type: 'audio', sceneId: 'a', status: 'failed', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'audio', sceneId: 'a', status: 'succeeded', createdAt: '2026-01-02T00:00:00.000Z' },
    { type: 'audio', sceneId: 'b', status: 'failed', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'image', sceneId: 'a', status: 'failed', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const byAudio = buildLatestJobsByScene(recentJobs, 'audio');
  assert.equal(byAudio.get('a').status, 'succeeded', 'newest job wins, not the first one seen');
  assert.equal(byAudio.get('b').status, 'failed');
  assert.equal(byAudio.get('c'), undefined, 'a scene with no matching job has no entry');
  const byImage = buildLatestJobsByScene(recentJobs, 'image');
  assert.equal(byImage.get('a').status, 'failed');
  assert.equal(byImage.get('b'), undefined, 'jobs for a different scene never leak across scenes');
});

test('computeStageStatus: durable video attempts are queued work, not missing work', async () => {
  const { computeStageStatus, buildLatestJobsByScene } = await stagesPromise;
  const scenes = [scene({ id: 'queued-video' })];
  const jobs = [
    { type: 'video', sceneId: 'queued-video', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'video', sceneId: 'queued-video', status: 'succeeded', createdAt: '2026-01-02T00:00:00.000Z' },
  ];
  const latest = buildLatestJobsByScene(jobs, 'video');
  assert.equal(latest.get('queued-video').status, 'queued', 'the durable attempt outranks its short-lived HTTP admission job');
  const status = computeStageStatus(scenes, { videos: { state: 'idle', generating: false } }, null, jobs, {});
  assert.equal(status.video.pending, 1);
  assert.equal(status.video.missing, 0);
  assert.match(status.video.label, /1 queued/);
});

test('computeStageStatus: paused stage status survives a simulated reload via persisted stageRuns, not just in-memory batchState', async () => {
  const { computeStageStatus } = await stagesPromise;
  const scenes = [scene({ id: 'a' })];
  const freshBatchState = { images: { state: 'idle', generating: false }, audio: { state: 'idle' }, videos: { state: 'idle' } };
  const status = computeStageStatus(scenes, freshBatchState, null, [], { images: 'paused' });
  assert.equal(status.images.paused, true);
});

test('resolveSelectedSceneIndex: falls back to 0 for an empty project, a never-selected id, or a removed scene', async () => {
  const { resolveSelectedSceneIndex } = await stagesPromise;
  assert.equal(resolveSelectedSceneIndex([], 'anything'), 0);
  const scenes = [scene({ id: 'a' }), scene({ id: 'b' }), scene({ id: 'c' })];
  assert.equal(resolveSelectedSceneIndex(scenes, null), 0, 'never selected yet');
  assert.equal(resolveSelectedSceneIndex(scenes, 'nonexistent'), 0, 'selected scene was removed');
  assert.equal(resolveSelectedSceneIndex(scenes, 'b'), 1, 'resolves the real index once found');
});

test('computeRunRange: "all" always runs to the end of the project; "next" clamps at the end rather than overrunning it', async () => {
  const { computeRunRange } = await stagesPromise;
  const scenes = [scene({ id: 'a' }), scene({ id: 'b' }), scene({ id: 'c' }), scene({ id: 'd' })];
  assert.deepEqual(computeRunRange(scenes, 'b', 'all', 5), { startIndex: 1, endIndex: 4 }, '"all" ignores count entirely');
  assert.deepEqual(computeRunRange(scenes, 'b', 'next', 2), { startIndex: 1, endIndex: 3 });
  assert.deepEqual(computeRunRange(scenes, 'b', 'next', 50), { startIndex: 1, endIndex: 4 }, 'clamps to scenes.length, never runs past it');
  assert.deepEqual(computeRunRange(scenes, 'b', 'next', 0), { startIndex: 1, endIndex: 2 }, 'count is floored at 1, never a zero-scene range');
});

test('buildRunRowStatus: images/audio/video are scoped to the selected range, but planning always reads the whole project', async () => {
  const { buildRunRowStatus } = await stagesPromise;
  const doneVersion = { path: '/a.png', prompt: 'Ink style.\n\nMara opens the door, hallway beyond.', scenePrompt: 'Mara opens the door, hallway beyond.' };
  // Scenes 0-1 already have images; scenes 2-3 are missing them. A range covering only 0-1 must
  // read as fully done for Images even though the whole project still has missing work.
  const scenes = [
    scene({ id: 'a', versions: [doneVersion], activeVersionIndex: 0 }),
    scene({ id: 'b', versions: [doneVersion], activeVersionIndex: 0 }),
    scene({ id: 'c' }),
    scene({ id: 'd' }),
  ];
  const batchState = { images: { state: 'idle', generating: false }, audio: { state: 'idle' }, videos: { state: 'idle' } };
  const range = { startIndex: 0, endIndex: 2 };
  const rowStatus = buildRunRowStatus(scenes, range, batchState, null, [], {});

  assert.equal(rowStatus.images.ranged.missing, 0, 'range 0-2 has no missing images');
  assert.equal(rowStatus.images.ranged.done, 2);
  assert.equal(rowStatus.images.full.missing, 2, 'the whole-project count still reflects scenes 2-3');
  assert.equal(rowStatus.images.full.total, 4);
  assert.deepEqual(rowStatus.planning.ranged, rowStatus.planning.full, 'planning has no range-scoped mode');
});

test('computeForceStages: flags explicitly checked up-to-date stages, including Planning', async () => {
  const { computeForceStages } = await stagesPromise;
  const rowStatus = {
    // images: nothing to do in range (already complete there) but the user checked it anyway.
    images: { ranged: { total: 2, missing: 0, stale: 0, failed: 0 } },
    // audio: genuinely has missing work in range — checking it must NOT force a redo of anything
    // already fresh, so it must never appear in forceStages.
    audio: { ranged: { total: 2, missing: 1, stale: 0, failed: 0 } },
    // video: has no work in range AND is unchecked — force is irrelevant, must not appear.
    video: { ranged: { total: 2, missing: 0, stale: 0, failed: 0 } },
    // planning: no work in range but checked — this explicitly requests a complete replan.
    planning: { ranged: { total: 2, missing: 0, stale: 0, failed: 0, hasChanges: false } },
  };
  const selection = { planning: true, images: true, audio: true, video: false };
  const forced = computeForceStages(rowStatus, selection);
  assert.deepEqual(forced.sort(), ['images', 'planning']);
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
  const empty = { planning: { total: 0, missing: 0, stale: 0, failed: 0 }, images: { total: 0, missing: 0, stale: 0, failed: 0 }, audio: { total: 0, missing: 0, stale: 0, failed: 0 }, video: { total: 0, missing: 0, stale: 0, failed: 0 }, subtitles: { total: 0, missing: 0, stale: 0, failed: 0 } };
  const selection = getStageSelection(empty);
  assert.equal(selection.planning, true, 'an empty project always needs Planning');
  assert.equal(selection.images, false);
  assert.equal(selection.audio, false);
  assert.equal(selection.video, false);
  assert.equal(selection.subtitles, false);
});

test('getStageSelection: defaults to selected for any stage with missing/stale/failed work, unselected when already up to date', async () => {
  const { getStageSelection } = await stagesPromise;
  const status = {
    planning: { total: 5, missing: 0, stale: 0, failed: 0 }, // fully planned, nothing to do
    images: { total: 5, missing: 0, stale: 2, failed: 0 }, // stale — should default-select
    audio: { total: 5, missing: 5, stale: 0, failed: 0 }, // missing — should default-select
    video: { total: 5, missing: 0, stale: 0, failed: 0 }, // up to date — should NOT default-select
    subtitles: { total: 5, missing: 0, stale: 0, failed: 0 }, // up to date — should NOT default-select
  };
  const selection = getStageSelection(status);
  assert.equal(selection.planning, false, 'a fully up-to-date Planning box has nothing to select');
  assert.equal(selection.images, true);
  assert.equal(selection.audio, true);
  assert.equal(selection.video, false);
  assert.equal(selection.subtitles, false);
});

test('toggleStageSelection: a box is never permanently disabled — the user can select or deselect ANY stage, even one with no detected work', async () => {
  const { getStageSelection, toggleStageSelection } = await stagesPromise;
  const status = {
    planning: { total: 5, missing: 0, stale: 0, failed: 0 },
    images: { total: 5, missing: 0, stale: 3, failed: 0 },
    audio: { total: 5, missing: 0, stale: 0, failed: 0 },
    video: { total: 5, missing: 0, stale: 0, failed: 0 },
    subtitles: { total: 5, missing: 0, stale: 0, failed: 0 },
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

  // Shot count is an output of planning now, not an input to compare — a sceneCount field drifting
  // (e.g. stale leftover data, or a manual split changing the real count) must NOT by itself mark
  // planning as needing a re-run.
  const recordCountChanged = {
    ...recordNoChanges,
    sceneCount: 5,
  };
  assert.equal(hasPlanningChanges(scenes, recordCountChanged), false, 'sceneCount is no longer compared, so a differing value alone must not be seen as a change');

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
