function startVideoReconciliationWorker(videos, { intervalMs = 30_000, onError, onTick, distributedLock } = {}) {
  const logError = onError || ((error) => console.error('[video-reconciliation] reconcile pass failed:', error));
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const reconcile = () => videos.reconcileAttempts();
      const locked = distributedLock ? await distributedLock.tryRun('video-provider-lifecycle-reconciliation', reconcile) : { acquired: true, value: await reconcile() };
      if (!locked.acquired) return;
      const outcomes = locked.value;
      if (outcomes.length) {
        const pending = outcomes.filter((o) => o.pending).length;
        const failed = outcomes.filter((o) => o.failed).length;
        const cancelled = outcomes.filter((o) => o.cancelled).length;
        const completed = outcomes.length - pending - failed - cancelled;
        console.log(`[video-reconciliation] pass processed=${outcomes.length} pending=${pending} completed=${completed} failed=${failed} cancelled=${cancelled}`);
      }
      if (onTick) onTick(outcomes);
    } catch (error) {
      logError(error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick();

  return { stop: () => clearInterval(timer) };
}

module.exports = { startVideoReconciliationWorker };
