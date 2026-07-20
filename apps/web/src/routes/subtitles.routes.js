const express = require('express');
const { validate } = require('../middleware/validate');
const { subtitleGeneration } = require('../schemas');
const { asyncRoute } = require('./helpers');

function subtitlesRoutes({ controller, idempotency, execute }) {
  const router = express.Router();
  router.post('/generate', validate(subtitleGeneration), idempotency, execute('subtitle'), asyncRoute(controller.subtitle));
  return router;
}

module.exports = { subtitlesRoutes };
