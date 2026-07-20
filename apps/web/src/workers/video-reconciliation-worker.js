function startVideoReconciliationWorker(videos, { intervalMs = 30_000, onError, onTick } = {}) {
  const logError = onError || ((error) => console.error('[video-reconciliation] reconcile pass failed:', error));
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const outcomes = await videos.reconcileAttempts();
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
