const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVideoProviders } = require('../src/providers/video');
const { createLocalVideoAssetTransport } = require('../src/providers/video/asset-transport');
const { createVideoExecutionService } = require('../src/services/video-execution.service');
const { ProviderAdmissionQueue } = require('../src/services/provider-admission-queue');
const { VideoGenerationAttemptStore } = require('../src/storage/video-generation-attempt-store');
const { resolveVideoInputPlan } = require('../src/shared/video-input-plan');
const { videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');
const { providerResult } = require('../src/providers/result');
const { mergeMediaIntent, resolveVideoOutput } = require('../src/shared/media-output-policy');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-architecture-'));
  const config = { env: {}, ltxUrl: 'http://ltx.test', paths: { ltxShared: path.join(root, 'ltx'), stubs: path.join(root, 'stubs') } };
  return { root, config, attempts: new VideoGenerationAttemptStore(path.join(root, 'attempts')), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('video provider registry dispatches per request and rejects unknown providers', async () => {
  const f = fixture();
  try {
    const calls = [];
    const adapter = (name) => ({ name, verify: async () => { calls.push(name); return { ok: true, provider: name }; } });
    const providers = createVideoProviders(f.config, () => null, null, { ltx: adapter('ltx'), stub: adapter('stub') });
    await providers.verify({ provider: 'stub', mode: 'image_to_video' });
    await providers.verify({ provider: 'ltx', mode: 'image_to_video' });
    assert.deepEqual(calls, ['stub', 'ltx']);
    assert.throws(() => providers.get('sora'), (error) => error.code === 'UNSUPPORTED_VIDEO_PROVIDER');
  } finally { f.cleanup(); }
});

test('provider/model/mode capabilities resolve explicitly and do not expose unimplemented modes', () => {
  assert.equal(videoProviderCapabilities('ltx', 'ltx-video', 'image_to_video').provider, 'ltx');
  assert.equal(videoProviderCapabilities('stub', 'stub-video-v1', 'image_to_video').model, 'stub-video-v1');
  assert.throws(() => videoProviderCapabilities('ltx', 'unknown', 'image_to_video'), /Unsupported video model/);
  assert.throws(() => videoProviderCapabilities('ltx', 'ltx-video', 'first_last_frame'), /does not implement/);
});

test('typed video input planning includes supported inputs and explicitly excludes every unsupported input', () => {
  const plan = resolveVideoInputPlan({ provider: 'ltx', mode: 'image_to_video', inputs: [
    { role: 'start_frame', assetId: 'start', assetPath: '/start.png', sourcePath: '/private/start.png', sha256: 'a'.repeat(64), instruction: 'Begin here' },
    { role: 'end_frame', assetId: 'end', assetPath: '/end.png', sha256: 'b'.repeat(64) },
    { role: 'character', assetId: 'cast', assetPath: '/cast.png', sha256: 'c'.repeat(64) },
  ], output: { durationSeconds: 5, aspectRatio: '4:3', resolution: '640x480', audioPolicy: 'none', seed: 42, providerOptions: { version: 1, values: { experimental: true } } } });
  assert.equal(plan.included.length, 1);
  assert.equal(plan.included[0].providerSlot, 'start_frame');
  assert.deepEqual(plan.excluded.map(({ role, reason }) => ({ role, reason })), [
    { role: 'end_frame', reason: 'unsupported_input_role' },
    { role: 'character', reason: 'unsupported_input_role' },
  ]);
  assert.equal(plan.output.providerOptions.version, 1);
});

test('synchronous LTX is represented as an immediately completed common lifecycle task', async () => {
  const f = fixture();
  const originalFetch = global.fetch;
  try {
    const sourcePath = path.join(f.root, 'source.png');
    const outputPath = path.join(f.root, 'output.mp4');
    fs.writeFileSync(sourcePath, 'image');
    global.fetch = async (url, options) => {
      if (String(url).endsWith('/ready')) return new Response('{}', { status: 200 });
      const body = JSON.parse(options.body);
      fs.writeFileSync(body.output, 'video');
      return new Response(JSON.stringify({ id: 'ltx-task-1', usage: { local: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const providers = createVideoProviders(f.config, () => null);
    const execution = createVideoExecutionService({ providers, attempts: f.attempts, assetTransport: createLocalVideoAssetTransport() });
    const inputPlan = resolveVideoInputPlan({ provider: 'ltx', mode: 'image_to_video', inputs: [{ role: 'start_frame', assetPath: '/start.png', sourcePath, sha256: 'a'.repeat(64) }] });
    const outputSelection = resolveVideoOutput({ provider: 'ltx', model: 'ltx-video', intent: mergeMediaIntent({ modality: 'video' }) });
    const result = await execution.create({ provider: 'ltx', model: 'ltx-video', generationMode: 'image_to_video', prompt: 'Move.', motionIntensity: 'medium', inputPlan, outputSelection, outputPath }, { projectId: 'project', sceneId: 'scene' });
    assert.equal(result.pending, false);
    assert.equal(result.result.provider, 'ltx');
    assert.equal(result.attempt.lifecycleState, 'validating');
    assert.equal(result.attempt.providerTaskId, 'ltx-task-1');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'video');
  } finally { global.fetch = originalFetch; f.cleanup(); }
});

test('submitted provider attempts survive store reconstruction and retain immutable recovery state', async () => {
  const f = fixture();
  try {
    const created = f.attempts.create({ provider: 'stub', model: 'stub-video-v1', generationMode: 'image_to_video', requestSnapshot: { schemaVersion: 1, prompt: 'original' }, providerTaskId: 'remote-1', lifecycleState: 'submitted', pollAfter: new Date(Date.now() - 1000).toISOString(), inputHashes: [{ role: 'start_frame', sha256: 'a'.repeat(64) }] });
    f.attempts.update(created.id, { requestSnapshot: { prompt: 'mutated' }, retryCount: 2 });
    const restored = new VideoGenerationAttemptStore(path.join(f.root, 'attempts'));
    const [recoverable] = restored.listRecoverable();
    assert.equal(recoverable.id, created.id);
    assert.equal(recoverable.providerTaskId, 'remote-1');
    assert.equal(recoverable.requestSnapshot.prompt, 'original');
    assert.equal(recoverable.retryCount, 2);
  } finally { f.cleanup(); }
});

test('a reconstructed execution service reconciles a submitted provider task without the original request', async () => {
  const f = fixture();
  try {
    const pendingAdapter = {
      name: 'stub', model: 'stub-video-v1', async verify() { return { ok: true }; }, async prepareAssets(request) { return request; },
      async submit() { return { state: 'submitted', providerTaskId: 'remote-resume' }; },
      async inspect(task) { return { ...task, state: 'completed', response: providerResult({ output: { outputPath: '/recovered.mp4' }, provider: 'stub', model: 'stub-video-v1', usage: { videos: 1 }, measurementStatus: 'not_applicable' }) }; },
      async cancel(task) { return task; }, async fetchResult(task) { return task.response; }, normalizeUsage(value) { return value; },
    };
    const providers = createVideoProviders(f.config, () => null, null, { stub: pendingAdapter });
    const firstExecution = createVideoExecutionService({ providers, attempts: f.attempts, assetTransport: createLocalVideoAssetTransport() });
    const inputPlan = resolveVideoInputPlan({ provider: 'stub', mode: 'image_to_video', inputs: [{ role: 'start_frame', assetPath: '/start.png', sourcePath: '/start.png', sha256: 'a'.repeat(64) }] });
    const submitted = await firstExecution.create({ provider: 'stub', generationMode: 'image_to_video', prompt: 'Move.', inputPlan, outputPath: '/recovered.mp4' });
    const restoredAttempts = new VideoGenerationAttemptStore(path.join(f.root, 'attempts'));
    const recoveredExecution = createVideoExecutionService({ providers, attempts: restoredAttempts, assetTransport: createLocalVideoAssetTransport() });
    const [outcome] = await recoveredExecution.reconcile();
    assert.equal(outcome.pending, false);
    assert.equal(outcome.result.output.outputPath, '/recovered.mp4');
    assert.equal(outcome.attempt.downloadState, 'downloaded');
  } finally { f.cleanup(); }
});

test('a lifecycle-serialized provider admits durable queued attempts one at a time in global FIFO order', async () => {
  const f = fixture();
  try {
    const sourcePath = path.join(f.root, 'source.png');
    fs.writeFileSync(sourcePath, 'image');
    const events = [];
    const serializedAdapter = {
      name: 'stub', model: 'stub-video-v1',
      async verify() { return { ok: true }; },
      async prepareAssets(request) {
        assert.equal(request.inputPlan.included[0].sourcePath, sourcePath, 'queued recovery retains the source path needed after restart');
        return request;
      },
      async submit(request) {
        events.push(`submit:${request.prompt}`);
        return { state: 'submitted', providerTaskId: `remote-${request.prompt}`, pollAfter: new Date(Date.now() - 1).toISOString(), requestSnapshot: request };
      },
      async inspect(task) {
        events.push(`inspect:${task.requestSnapshot.prompt}`);
        return { ...task, state: 'completed', response: providerResult({ output: { outputPath: task.requestSnapshot.outputPath }, provider: 'stub', model: 'stub-video-v1', usage: { videos: 1 }, measurementStatus: 'not_applicable' }) };
      },
      async cancel(task) { return { ...task, state: 'cancelled' }; },
      async fetchResult(task) { return task.response; },
      normalizeUsage(value) { return value; },
    };
    const providerAdmission = new ProviderAdmissionQueue({ defaultMinIntervalMs: 0, policies: { stub: { lifecycle: 'serial' } } });
    const providers = createVideoProviders(f.config, () => null, null, { stub: serializedAdapter }, providerAdmission);
    const execution = createVideoExecutionService({ providers, attempts: f.attempts, assetTransport: createLocalVideoAssetTransport(), providerAdmission });
    const inputPlan = resolveVideoInputPlan({ provider: 'stub', mode: 'image_to_video', inputs: [{ role: 'start_frame', assetPath: '/start.png', sourcePath, sha256: 'a'.repeat(64) }] });

    const first = await execution.create({ provider: 'stub', generationMode: 'image_to_video', prompt: 'first', inputPlan, outputPath: path.join(f.root, 'first.mp4') });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await execution.create({ provider: 'stub', generationMode: 'image_to_video', prompt: 'second', inputPlan, outputPath: path.join(f.root, 'second.mp4') });
    assert.equal(first.attempt.lifecycleState, 'queued');
    assert.equal(second.attempt.lifecycleState, 'queued');
    assert.deepEqual(events, [], 'HTTP admission does not submit either remote task directly');
    const reconcile = () => execution.reconcile(({ attempt }) => execution.markCommitted(attempt.id));

    await reconcile();
    assert.deepEqual(events, ['submit:first'], 'the first pass admits only the oldest queued attempt');
    assert.equal(f.attempts.get(second.attempt.id).lifecycleState, 'queued');

    await reconcile();
    assert.deepEqual(events, ['submit:first', 'inspect:first'], 'the next attempt stays queued during the pass that completes the active task');

    await reconcile();
    assert.deepEqual(events, ['submit:first', 'inspect:first', 'submit:second'], 'the second task starts only after a pass observes no active task');
    assert.ok(f.attempts.get(second.attempt.id).providerSubmittedAt);
  } finally { f.cleanup(); }
});

test('provider task cancellation is persisted independently of an HTTP request', async () => {
  const f = fixture();
  try {
    const pendingAdapter = {
      name: 'stub', async verify() { return { ok: true }; }, async prepareAssets(request) { return request; },
      async submit() { return { state: 'submitted', providerTaskId: 'remote-cancel' }; },
      async inspect(task) { return task; }, async cancel(task) { return { ...task, state: 'cancelled' }; },
      async fetchResult() { throw new Error('not complete'); }, normalizeUsage(value) { return value; },
    };
    const providers = createVideoProviders(f.config, () => null, null, { stub: pendingAdapter });
    const execution = createVideoExecutionService({ providers, attempts: f.attempts, assetTransport: createLocalVideoAssetTransport() });
    const inputPlan = resolveVideoInputPlan({ provider: 'stub', mode: 'image_to_video', inputs: [{ role: 'start_frame', assetPath: '/start.png', sourcePath: '/start.png', sha256: 'a'.repeat(64) }] });
    const submitted = await execution.create({ provider: 'stub', generationMode: 'image_to_video', prompt: 'Move.', inputPlan, outputPath: '/output.mp4' });
    const cancelled = await execution.cancel(submitted.attempt.id);
    assert.equal(cancelled.lifecycleState, 'cancelled');
    assert.equal(cancelled.cancellationState, 'cancelled');
    assert.ok(cancelled.completedAt);
  } finally { f.cleanup(); }
});
