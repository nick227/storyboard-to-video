const express = require('express');
const { asyncRoute } = require('./helpers');

function mediaOutputRoutes(service) {
  const router = express.Router();
  router.get('/policy', (req, res) => res.json({ ok: true, policy: service.policy() }));
  router.post('/quote', asyncRoute(async (req, res) => res.json({ ok: true, ...(await service.quote(req.body || {}, { ownerId: req.auth.tenantId, userId: req.auth.userId })) })));
  router.post('/video-duration-options', asyncRoute(async (req, res) => res.json({ ok: true, ...(await service.videoDurationOptions(req.body || {}, { ownerId: req.auth.tenantId, userId: req.auth.userId })) })));
  router.post('/image-output-options', asyncRoute(async (req, res) => res.json({ ok: true, ...(await service.imageOutputOptions(req.body || {}, { ownerId: req.auth.tenantId, userId: req.auth.userId })) })));
  return router;
}

module.exports = { mediaOutputRoutes };
