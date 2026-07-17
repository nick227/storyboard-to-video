const { AppError } = require('../errors');

function createJobExecution({ queue, projectStore, idempotencyStore, generationContext }) {
  return (type) => async (req, res, next) => {
    try {
      await projectStore.read(req.body?.projectId, { ownerId: req.auth.tenantId });
      const queued = await queue.add(type, req.body.projectId, (signal, jobId) => new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve({ statusCode: res.statusCode }); } };
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
