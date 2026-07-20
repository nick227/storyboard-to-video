const express = require('express');
const { validate } = require('../middleware/validate');
const { videoGeneration } = require('../schemas');
const { asyncRoute } = require('./helpers');

function videosRoutes({ controller, idempotency, execute }) {
  const router = express.Router();
  router.get('/preflight', asyncRoute(controller.videoPreflight));
  router.get('/attempts/:attemptId', asyncRoute(controller.videoAttemptStatus));
  router.post('/generate', validate(videoGeneration), idempotency, execute('video'), asyncRoute(controller.video));
  return router;
}

module.exports = { videosRoutes };
