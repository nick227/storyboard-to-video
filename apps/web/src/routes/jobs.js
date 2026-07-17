const express = require('express');

function createJobRouter({ queue, store }) {
  const router = express.Router();
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const canAccess = async (job, ownerId) => {
    if (!job.projectId) return false;
    try { await store.read(job.projectId, { ownerId }); return true; } catch (_) { return false; }
  };

  router.get('/', asyncRoute(async (req, res) => {
    const candidates = await queue.list(req.query.projectId);
    const access = await Promise.all(candidates.map((job) => canAccess(job, req.auth.tenantId)));
    const jobs = candidates.filter((_, index) => access[index]);
    res.json({ ok: true, jobs });
  }));
  router.get('/:jobId', asyncRoute(async (req, res) => {
    const job = await queue.get(req.params.jobId);
    if (!await canAccess(job, req.auth.tenantId)) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
    res.json({ ok: true, job });
  }));
  router.delete('/:jobId', asyncRoute(async (req, res) => {
    const job = await queue.get(req.params.jobId);
    if (!await canAccess(job, req.auth.tenantId)) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
    res.json({ ok: true, job: await queue.cancel(req.params.jobId) });
  }));
  return router;
}

module.exports = { createJobRouter };
