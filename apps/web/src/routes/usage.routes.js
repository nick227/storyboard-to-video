const express = require('express');
const { AppError } = require('../errors');
const { styleAdmin } = require('../middleware/style-admin');
const { asyncRoute } = require('./helpers');

function usageRoutes(repository) {
  const router = express.Router();
  router.get('/', styleAdmin, asyncRoute(async (req, res) => {
    if (!repository) throw new AppError('USAGE_UNAVAILABLE', 'Usage persistence is unavailable', { status: 503 });
    const tenantId = req.query.tenantId ? String(req.query.tenantId) : undefined;
    if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) throw new AppError('INVALID_TENANT_ID', 'tenantId must be a UUID', { status: 400 });
    const events = await repository.list({ tenantId, limit: req.query.limit });
    res.json({ ok: true, events });
  }));
  return router;
}

module.exports = { usageRoutes };
