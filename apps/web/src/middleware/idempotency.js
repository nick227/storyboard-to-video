const { AppError } = require('../errors');

function requireIdempotency(store, projectStore) {
  return (req, res, next) => {
    const projectId = req.body?.projectId;
    if (!projectId) return next(new AppError('PROJECT_REQUIRED', 'projectId is required for generation', { status: 400 }));
    try { projectStore.read(projectId, { ownerId: req.user.id }); } catch (error) { return next(error); }
    const key = String(req.get('Idempotency-Key') || '');
    if (!/^[a-zA-Z0-9_.:-]{8,200}$/.test(key)) return next(new AppError('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required', { status: 400 }));
    try {
      const entry = store.begin(projectId, key, req.body);
      if (entry.reused && entry.record.status === 'completed') return res.status(entry.record.statusCode).json(entry.record.body);
      if (entry.reused) return res.status(202).json({ ok: true, reused: true, job: { id: entry.record.jobId, status: entry.record.status } });
      req.idempotencyKey = key;
      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 400) store.complete(projectId, key, res.statusCode, body);
        else store.fail(projectId, key);
        return json(body);
      };
      next();
    } catch (error) { next(error); }
  };
}

module.exports = { requireIdempotency };
