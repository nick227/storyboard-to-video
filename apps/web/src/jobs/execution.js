const { AppError } = require('../errors');

function createJobExecution({ queue, projectStore, idempotencyStore, generationContext }) {
  return (type) => async (req, res, next) => {
    try {
      await projectStore.read(req.body?.projectId, { ownerId: req.auth.tenantId });
      const queued = await queue.add(type, req.body.projectId, (signal, jobId) => new Promise((resolve, reject) => {
        let settled = false;
        // `res.finish` fires for an application error response too (Express's error middleware still
        // sends a clean JSON body and ends the request normally) — relying on "did the response
        // finish" alone marked every generation "succeeded" regardless of outcome, so the job's
        // failed/error state (job history, the stage-bar failed counts, the per-scene status-icon
        // failed state) never reflected a real provider/validation failure, only an actual
        // cancellation. By the time `finish` fires, `res.statusCode` already reflects the real
        // outcome, so use that instead of assuming success.
        const finish = () => {
          if (settled) return;
          settled = true;
          if (res.statusCode >= 400) {
            // req.generationError is stashed by the global error handler (app.js) with the real
            // thrown error, before the response goes out — preferred over a generic message so job
            // history/failed-state UI shows what actually went wrong.
            reject(req.generationError || new AppError('REQUEST_FAILED', `Request failed with status ${res.statusCode}`, { status: res.statusCode }));
          } else {
            resolve({ statusCode: res.statusCode });
          }
        };
        const abort = () => { if (!settled) { settled = true; reject(signal.reason || new AppError('JOB_CANCELLED', 'Generation job cancelled', { status: 409 })); } };
        res.once('finish', finish);
        res.once('close', finish);
        signal.addEventListener('abort', abort, { once: true });
        req.generationSignal = signal;
        req.generationJobId = jobId;
        generationContext.run({
          signal,
          providerSequence: 0,
          trace: {
            tenantId: req.auth.tenantId,
            userId: req.auth.userId,
            projectId: req.body.projectId,
            sceneId: req.body.sceneId || null,
            jobId,
            idempotencyKey: req.idempotencyKey || null,
          },
        }, next);
      }), {
        sceneId: req.body?.sceneId,
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        idempotencyKey: req.idempotencyKey,
      });
      res.set('X-Generation-Job-Id', queued.id);
      if (req.idempotencyKey) await idempotencyStore.attach(req.body.projectId, req.idempotencyKey, queued.id);
      queued.promise.catch((error) => { if (!res.headersSent) next(error); });
    } catch (error) { next(error); }
  };
}

module.exports = { createJobExecution };
