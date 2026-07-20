const { snapshotVideoPlan } = require('../shared/video-input-plan');

const PROVIDER_PENDING_STATES = new Set(['submitted', 'queued', 'running', 'provider_running']);

function iso(value) { return value ? new Date(value).toISOString() : null; }
function errorSnapshot(error) { return { code: error.code || 'VIDEO_PROVIDER_FAILED', message: String(error.message || error).slice(0, 1000) }; }

function immutableSnapshot(request) {
  return structuredClone({
    schemaVersion: 1,
    provider: request.provider,
    model: request.model,
    generationMode: request.generationMode,
    prompt: request.prompt,
    motionIntensity: request.motionIntensity,
    outputSelection: request.outputSelection,
    outputPath: request.outputPath,
    inputPlan: snapshotVideoPlan(request.inputPlan),
    finalization: request.finalization || null,
  });
}

function createVideoExecutionService({ providers, attempts, usageTracker, assetTransport }) {
  async function create(request, trace = {}) {
    const { adapter, capabilities, model, mode } = providers.resolve({ provider: request.provider, model: request.model, mode: request.generationMode });
    const snapshot = immutableSnapshot({ ...request, model, generationMode: mode });
    const attempt = await attempts.create({
      generationJobId: trace.jobId || null, tenantId: trace.tenantId || null, userId: trace.userId || null,
      projectId: trace.projectId || null, sceneId: trace.sceneId || null,
      provider: request.provider, model, generationMode: mode, requestSnapshot: snapshot,
      lifecycleState: 'preparing_assets', inputHashes: request.inputPlan.included.map(({ role, assetId, assetPath, sha256 }) => ({ role, assetId, assetPath, sha256 })),
    });
    let usageHandle = null;
    try {
      usageHandle = usageTracker ? await usageTracker.begin({ modality: 'video', provider: request.provider, model, estimatedUsage: { videos: 1, ...(request.outputSelection?.resolved?.width ? { width: request.outputSelection.resolved.width } : {}), ...(request.outputSelection?.resolved?.height ? { height: request.outputSelection.resolved.height } : {}), ...(request.outputSelection?.resolved?.durationSeconds ? { seconds: request.outputSelection.resolved.durationSeconds } : {}), resolutionTier: request.outputSelection?.resolved?.resolutionTier, resolution: request.outputSelection?.resolved?.providerSettings?.resolution }, inputMetadata: { generationMode: mode, promptCharacters: String(request.prompt || '').length, inputCount: request.inputPlan.included.length, outputIntent: request.inputPlan.output, output: request.outputSelection } }) : null;
      if (usageHandle) await attempts.update(attempt.id, { generationRequestId: usageHandle.request.id, costReferences: usageHandle.references });
      const prepared = await adapter.prepareAssets({ ...request, model, generationMode: mode, capabilities }, assetTransport);
      const task = await adapter.submit(prepared);
      const lifecycleState = task.state === 'completed' ? 'validating' : task.state === 'running' ? 'provider_running' : 'submitted';
      const updated = await attempts.update(attempt.id, {
        providerTaskId: task.providerTaskId || null, providerOutputId: task.providerOutputId || null,
        outputExpiresAt: iso(task.outputExpiresAt), pollAfter: iso(task.pollAfter), lifecycleState,
      });
      if (task.state === 'completed') return finish(updated, adapter, task, usageHandle);
      return { pending: true, attempt: updated, capabilities };
    } catch (error) {
      await usageTracker?.fail(usageHandle, error);
      const cancelled = trace.signal?.aborted || error.code === 'JOB_CANCELLED';
      await attempts.update(attempt.id, { lifecycleState: cancelled ? 'cancelled' : 'failed', cancellationState: cancelled ? 'cancelled' : 'not_requested', error: errorSnapshot(error), completedAt: new Date().toISOString() });
      throw error;
    }
  }

  async function finish(attempt, adapter, task, usageHandle) {
    const rawResult = await adapter.fetchResult(task, assetTransport);
    const result = adapter.normalizeUsage(rawResult);
    await usageTracker?.complete(usageHandle || attempt.generationRequestId, result);
    const updated = await attempts.update(attempt.id, { lifecycleState: 'validating', downloadState: 'downloaded', providerOutputId: task.providerOutputId || attempt.providerOutputId || null, outputExpiresAt: iso(task.outputExpiresAt || attempt.outputExpiresAt) });
    return { pending: false, attempt: updated, result };
  }

  async function resume(attemptOrId) {
    const attempt = typeof attemptOrId === 'string' ? await attempts.get(attemptOrId) : attemptOrId;
    const { adapter } = providers.resolve({ provider: attempt.provider, model: attempt.model, mode: attempt.generationMode });
    if (attempt.cancellationState === 'requested') return cancel(attempt);
    const task = await adapter.inspect({ providerTaskId: attempt.providerTaskId, providerOutputId: attempt.providerOutputId, state: attempt.lifecycleState, outputExpiresAt: attempt.outputExpiresAt, requestSnapshot: attempt.requestSnapshot });
    if (PROVIDER_PENDING_STATES.has(task.state)) {
      return { pending: true, attempt: await attempts.update(attempt.id, { lifecycleState: task.state === 'running' ? 'provider_running' : 'submitted', pollAfter: iso(task.pollAfter), retryCount: attempt.retryCount + 1 }) };
    }
    if (task.state === 'cancelled') return { pending: false, cancelled: true, attempt: await attempts.update(attempt.id, { lifecycleState: 'cancelled', cancellationState: 'cancelled', completedAt: new Date().toISOString() }) };
    if (task.state === 'failed') {
      const error = Object.assign(new Error(task.error?.message || 'Video provider task failed'), task.error || {});
      await usageTracker?.fail(attempt.generationRequestId, error);
      await attempts.update(attempt.id, { lifecycleState: 'failed', error: errorSnapshot(error), completedAt: new Date().toISOString() });
      throw error;
    }
    return finish(attempt, adapter, task, null);
  }

  async function cancel(attemptOrId) {
    const attempt = typeof attemptOrId === 'string' ? await attempts.get(attemptOrId) : attemptOrId;
    const requested = await attempts.update(attempt.id, { cancellationState: 'requested' });
    const { adapter } = providers.resolve({ provider: requested.provider, model: requested.model, mode: requested.generationMode });
    const task = await adapter.cancel({ providerTaskId: requested.providerTaskId, state: requested.lifecycleState, requestSnapshot: requested.requestSnapshot });
    const terminal = task.state === 'cancelled';
    if (terminal) await usageTracker?.fail(requested.generationRequestId, Object.assign(new Error('Video generation cancelled'), { code: 'JOB_CANCELLED' }));
    return attempts.update(requested.id, { cancellationState: terminal ? 'cancelled' : 'requested', lifecycleState: terminal ? 'cancelled' : requested.lifecycleState, ...(terminal ? { completedAt: new Date().toISOString() } : {}) });
  }

  async function markCommitted(id) { return attempts.update(id, { lifecycleState: 'committed', commitState: 'committed', completedAt: new Date().toISOString() }); }
  async function markCommitFailed(id, error) { return attempts.update(id, { lifecycleState: 'failed', commitState: 'failed', error: errorSnapshot(error), completedAt: new Date().toISOString() }); }
  async function recoverable() { return attempts.listRecoverable(); }

  async function reconcile(onCompleted) {
    const results = [];
    for (const attempt of await recoverable()) {
      const outcome = await resume(attempt);
      if (!outcome.pending && !outcome.cancelled && onCompleted) await onCompleted(outcome);
      results.push(outcome);
    }
    return results;
  }

  return { cancel, create, markCommitted, markCommitFailed, reconcile, recoverable, resume };
}

module.exports = { createVideoExecutionService, immutableSnapshot };
