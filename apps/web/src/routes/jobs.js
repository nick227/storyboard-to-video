const express = require('express');

function createJobRouter({ queue, store }) {
  const router = express.Router();
  const canAccess = (job, ownerId) => {
    if (!job.projectId) return false;
    try { store.read(job.projectId, { ownerId }); return true; } catch (_) { return false; }
  };

  router.get('/', (req, res) => {
    const jobs = queue.list(req.query.projectId).filter((job) => canAccess(job, req.user.id));
    res.json({ ok: true, jobs });
  });
  router.get('/:jobId', (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!canAccess(job, req.user.id)) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
    res.json({ ok: true, job });
  });
  router.delete('/:jobId', (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!canAccess(job, req.user.id)) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
    res.json({ ok: true, job: queue.cancel(req.params.jobId) });
  });
  return router;
}

module.exports = { createJobRouter };
