const express = require('express');

function createJobRouter({ queue, store, videoAttempts, videoExecution }) {
  const router = express.Router();
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const activeVideoStates = new Set(['preparing_assets', 'queued', 'submitted', 'provider_running', 'downloading', 'validating']);
  const videoAttemptId = (value) => String(value || '').startsWith('video-attempt:') ? String(value).slice('video-attempt:'.length) : null;
  const getVideoAttempt = async (id) => { try { return await videoAttempts?.get(id); } catch (_) { return null; } };
  const publicVideoAttempt = (attempt) => ({
    id: `video-attempt:${attempt.id}`, type: 'video', projectId: attempt.projectId, sceneId: attempt.sceneId,
    tenantId: attempt.tenantId, userId: attempt.userId,
    status: attempt.lifecycleState === 'queued' || attempt.lifecycleState === 'preparing_assets' ? 'queued' : ['committed', 'cancelled', 'failed'].includes(attempt.lifecycleState) ? attempt.lifecycleState === 'committed' ? 'succeeded' : attempt.lifecycleState : 'running',
    createdAt: attempt.updatedAt || attempt.createdAt, attemptId: attempt.id, lifecycleState: attempt.lifecycleState,
  });
  const canAccess = async (job, ownerId) => {
    if (job.tenantId) return job.tenantId === ownerId;
    if (!job.projectId) return false;
    try { await store.read(job.projectId, { ownerId }); return true; } catch (_) { return false; }
  };

  router.get('/', asyncRoute(async (req, res) => {
    const candidates = await queue.list(req.query.projectId);
    const activeVideoAttempts = videoAttempts?.listActive
      ? await videoAttempts.listActive({ tenantId: req.auth.tenantId, ...(req.query.projectId ? { projectId: req.query.projectId } : {}) })
      : [];
    candidates.push(...activeVideoAttempts.map(publicVideoAttempt));
    const access = await Promise.all(candidates.map((job) => canAccess(job, req.auth.tenantId)));
    const jobs = candidates.filter((_, index) => access[index]);
    res.json({ ok: true, jobs });
  }));
  router.get('/:jobId', asyncRoute(async (req, res) => {
    const attemptId = videoAttemptId(req.params.jobId);
    if (attemptId && videoAttempts) {
      const attempt = await getVideoAttempt(attemptId);
      if (!attempt || attempt.tenantId !== req.auth.tenantId) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
      return res.json({ ok: true, job: publicVideoAttempt(attempt) });
    }
    const job = await queue.get(req.params.jobId);
    if (!await canAccess(job, req.auth.tenantId)) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
    res.json({ ok: true, job });
  }));
  router.delete('/:jobId', asyncRoute(async (req, res) => {
    const attemptId = videoAttemptId(req.params.jobId);
    if (attemptId && videoAttempts && videoExecution) {
      const attempt = await getVideoAttempt(attemptId);
      if (!attempt || attempt.tenantId !== req.auth.tenantId) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
      if (!activeVideoStates.has(attempt.lifecycleState)) return res.json({ ok: true, job: publicVideoAttempt(attempt) });
      return res.json({ ok: true, job: publicVideoAttempt(await videoExecution.cancel(attempt)) });
    }
    const job = await queue.get(req.params.jobId);
    if (!await canAccess(job, req.auth.tenantId)) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Generation job not found', retryable: false } });
    res.json({ ok: true, job: await queue.cancel(req.params.jobId) });
  }));
  return router;
}

module.exports = { createJobRouter };
