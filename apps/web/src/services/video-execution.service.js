const { snapshotVideoPlan } = require('../shared/video-input-plan');

const PROVIDER_PENDING_STATES = new Set(['submitted', 'queued', 'running', 'provider_running']);
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15 * 60_000;

function iso(value) { return value ? new Date(value).toISOString() : null; }
function errorSnapshot(error) { return { code: error.code || 'VIDEO_PROVIDER_FAILED', message: String(error.message || error).slice(0, 1000) }; }
function elapsedMs(attempt) { return Date.now() - new Date(attempt.createdAt).getTime(); }
function providerElapsedMs(attempt) { return Date.now() - new Date(attempt.providerSubmittedAt || attempt.createdAt).getTime(); }
function tag(attempt) { return `attempt=${attempt.id} scene=${attempt.sceneId || 'n/a'} provider=${attempt.provider} taskId=${attempt.providerTaskId || 'n/a'}`; }

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
    // A queued attempt may be submitted after an app restart, so its immutable recovery snapshot
    // must retain the resolved local source paths needed to stage its provider inputs.
    inputPlan: snapshotVideoPlan(request.inputPlan, { retainSourcePaths: true }),
    finalization: request.finalization || null,
  });
}

function createVideoExecutionService({ providers, attempts, usageTracker, assetTransport, attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS, providerAdmission = providers.providerAdmission }) {
  function serializesLifecycle(adapter, provider) {
    return adapter.serializesLifecycle === true || providerAdmission?.serializesLifecycle(provider) === true;
  }

  async function submitAttempt(attempt, adapter, request, capabilities, usageHandle) {
    const operation = async () => {
      const prepared = await adapter.prepareAssets(request, assetTransport);
      return adapter.submit(prepared);
    };
    const task = providerAdmission ? await providerAdmission.run(request.provider, operation) : await operation();
    const lifecycleState = task.state === 'completed' ? 'validating' : task.state === 'running' ? 'provider_running' : 'submitted';
    const updated = await attempts.update(attempt.id, {
      providerTaskId: task.providerTaskId || null, providerOutputId: task.providerOutputId || null,
      providerSubmittedAt: new Date().toISOString(),
      outputExpiresAt: iso(task.outputExpiresAt), pollAfter: iso(task.pollAfter), lifecycleState,
    });
    console.log(`[video] submit ${tag(updated)} state=${task.state}`);
    if (task.state === 'completed') return finish(updated, adapter, task, usageHandle);
    return { pending: true, attempt: updated, capabilities };
  }

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
    let currentAttempt = attempt;
    try {
      usageHandle = usageTracker ? await usageTracker.begin({ modality: 'video', provider: request.provider, model, estimatedUsage: { videos: 1, ...(request.outputSelection?.resolved?.width ? { width: request.outputSelection.resolved.width } : {}), ...(request.outputSelection?.resolved?.height ? { height: request.outputSelection.resolved.height } : {}), ...(request.outputSelection?.resolved?.durationSeconds ? { seconds: request.outputSelection.resolved.durationSeconds } : {}), resolutionTier: request.outputSelection?.resolved?.resolutionTier, resolution: request.outputSelection?.resolved?.providerSettings?.resolution }, inputMetadata: { generationMode: mode, promptCharacters: String(request.prompt || '').length, inputCount: request.inputPlan.included.length, outputIntent: request.inputPlan.output, output: request.outputSelection } }) : null;
      if (usageHandle) currentAttempt = await attempts.update(attempt.id, { generationRequestId: usageHandle.request.id, costReferences: usageHandle.references });
      if (serializesLifecycle(adapter, request.provider)) {
        const queued = await attempts.update(attempt.id, { lifecycleState: 'queued', pollAfter: null });
        console.log(`[video] queued ${tag(queued)}`);
        return { pending: true, attempt: queued, capabilities };
      }
      return submitAttempt(currentAttempt, adapter, { ...request, model, generationMode: mode, capabilities }, capabilities, usageHandle);
    } catch (error) {
      await usageTracker?.fail(usageHandle, error);
      const cancelled = trace.signal?.aborted || error.code === 'JOB_CANCELLED';
      const updated = await attempts.update(currentAttempt.id, { lifecycleState: cancelled ? 'cancelled' : 'failed', cancellationState: cancelled ? 'cancelled' : 'not_requested', error: errorSnapshot(error), completedAt: new Date().toISOString() });
      console.error(`[video] ${cancelled ? 'cancelled' : 'failed'} ${tag(updated)} stage=submit error=${error.message}`);
      throw error;
    }
  }

  async function finish(attempt, adapter, task, usageHandle) {
    const operation = () => adapter.fetchResult(task, assetTransport);
    const rawResult = providerAdmission ? await providerAdmission.run(attempt.provider, operation) : await operation();
    const result = adapter.normalizeUsage(rawResult);
    await usageTracker?.complete(usageHandle || attempt.generationRequestId, result);
    const updated = await attempts.update(attempt.id, { lifecycleState: 'validating', downloadState: 'downloaded', providerOutputId: task.providerOutputId || attempt.providerOutputId || null, outputExpiresAt: iso(task.outputExpiresAt || attempt.outputExpiresAt) });
    console.log(`[video] completed ${tag(updated)} elapsedMs=${elapsedMs(updated)}`);
    return { pending: false, attempt: updated, result };
  }

  async function resume(attemptOrId) {
    const attempt = typeof attemptOrId === 'string' ? await attempts.get(attemptOrId) : attemptOrId;
    const { adapter, capabilities } = providers.resolve({ provider: attempt.provider, model: attempt.model, mode: attempt.generationMode });
    if (attempt.cancellationState === 'requested') return cancel(attempt);
    if (attempt.lifecycleState === 'queued') {
      const usageHandle = await usageTracker?.restore(attempt.generationRequestId);
      try {
        return await submitAttempt(attempt, adapter, { ...attempt.requestSnapshot, capabilities }, capabilities, usageHandle);
      } catch (error) {
        await usageTracker?.fail(usageHandle || attempt.generationRequestId, error);
        const updated = await attempts.update(attempt.id, { lifecycleState: 'failed', error: errorSnapshot(error), completedAt: new Date().toISOString() });
        console.error(`[video] failed ${tag(updated)} stage=queued-submit error=${error.message}`);
        throw error;
      }
    }
    const inspect = () => adapter.inspect({ providerTaskId: attempt.providerTaskId, providerOutputId: attempt.providerOutputId, state: attempt.lifecycleState, outputExpiresAt: attempt.outputExpiresAt, requestSnapshot: attempt.requestSnapshot });
    const task = providerAdmission ? await providerAdmission.run(attempt.provider, inspect) : await inspect();
    if (PROVIDER_PENDING_STATES.has(task.state)) {
      const elapsed = providerElapsedMs(attempt);
      if (elapsed >= attemptTimeoutMs) {
        const error = Object.assign(new Error(`Video generation timed out after ${Math.round(attemptTimeoutMs / 60_000)}m — the provider never returned a completed status.`), { code: 'VIDEO_GENERATION_TIMEOUT' });
        console.error(`[video] timeout ${tag(attempt)} elapsedMs=${elapsed} retries=${attempt.retryCount}`);
        await usageTracker?.fail(attempt.generationRequestId, error);
        await attempts.update(attempt.id, { lifecycleState: 'failed', error: errorSnapshot(error), completedAt: new Date().toISOString() });
        throw error;
      }
      console.log(`[video] pending ${tag(attempt)} state=${task.state} elapsedMs=${elapsed} retry=${attempt.retryCount}`);
      return { pending: true, attempt: await attempts.update(attempt.id, { lifecycleState: task.state === 'running' ? 'provider_running' : 'submitted', pollAfter: iso(task.pollAfter), retryCount: attempt.retryCount + 1 }) };
    }
    if (task.state === 'cancelled') return { pending: false, cancelled: true, attempt: await attempts.update(attempt.id, { lifecycleState: 'cancelled', cancellationState: 'cancelled', completedAt: new Date().toISOString() }) };
    if (task.state === 'failed') {
      const error = Object.assign(new Error(task.error?.message || 'Video provider task failed'), task.error || {});
      console.error(`[video] failed ${tag(attempt)} elapsedMs=${elapsedMs(attempt)} error=${error.message}`);
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
    const operation = () => adapter.cancel({ providerTaskId: requested.providerTaskId, state: requested.lifecycleState, requestSnapshot: requested.requestSnapshot });
    const task = providerAdmission ? await providerAdmission.run(requested.provider, operation) : await operation();
    const terminal = task.state === 'cancelled';
    if (terminal) await usageTracker?.fail(requested.generationRequestId, Object.assign(new Error('Video generation cancelled'), { code: 'JOB_CANCELLED' }));
    return attempts.update(requested.id, { cancellationState: terminal ? 'cancelled' : 'requested', lifecycleState: terminal ? 'cancelled' : requested.lifecycleState, ...(terminal ? { completedAt: new Date().toISOString() } : {}) });
  }

  async function markCommitted(id) { return attempts.update(id, { lifecycleState: 'committed', commitState: 'committed', completedAt: new Date().toISOString() }); }
  async function markCommitFailed(id, error) { return attempts.update(id, { lifecycleState: 'failed', commitState: 'failed', error: errorSnapshot(error), completedAt: new Date().toISOString() }); }
  async function recoverable() { return attempts.listRecoverable(); }

  async function reconcile(onCompleted) {
    const results = [];
    const recoverableAttempts = await recoverable();
    // A provider with serializesLifecycle may have multiple legacy in-flight attempts from before
    // the queue was introduced; continue polling all of those, but do not admit any queued work
    // until a later pass observes zero active attempts. When no work is active, only the oldest
    // queued attempt is admitted in this pass. Repository ordering makes this a global tenant-FIFO.
    const serializedProvidersWithActive = new Set(recoverableAttempts.flatMap((attempt) => {
      const adapter = providers.resolve({ provider: attempt.provider, model: attempt.model, mode: attempt.generationMode }).adapter;
      return serializesLifecycle(adapter, attempt.provider) && attempt.lifecycleState !== 'queued' ? [attempt.provider] : [];
    }));
    const serializedProvidersAdmitted = new Set();
    for (const attempt of recoverableAttempts) {
      const adapter = providers.resolve({ provider: attempt.provider, model: attempt.model, mode: attempt.generationMode }).adapter;
      if (serializesLifecycle(adapter, attempt.provider) && attempt.lifecycleState === 'queued') {
        if (serializedProvidersWithActive.has(attempt.provider) || serializedProvidersAdmitted.has(attempt.provider)) continue;
        serializedProvidersAdmitted.add(attempt.provider);
      }
      try {
        const outcome = await resume(attempt);
        if (!outcome.pending && !outcome.cancelled && onCompleted) await onCompleted(outcome);
        results.push(outcome);
      } catch (error) {
        // resume() already logged and persisted the failure; keep this pass going so one stuck
        // or timed-out attempt doesn't block every other attempt from being reconciled this tick.
        console.error(`[video] reconcile skipped ${tag(attempt)} error=${error.message}`);
        results.push({ pending: false, failed: true, attempt, error });
      }
    }
    return results;
  }

  return { cancel, create, markCommitted, markCommitFailed, reconcile, recoverable, resume };
}

module.exports = { createVideoExecutionService, immutableSnapshot };
