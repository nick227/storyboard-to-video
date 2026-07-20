const express = require('express');
const { validate } = require('../middleware/validate');
const { imageGeneration } = require('../schemas');
const { asyncRoute } = require('./helpers');

function imagesRoutes({ controller, idempotency, execute }) {
  const router = express.Router();
  router.post('/preflight', validate(imageGeneration), asyncRoute(controller.imagePreflight));
  router.post('/generate', validate(imageGeneration), idempotency, execute('image'), asyncRoute(controller.image));
  return router;
}

module.exports = { imagesRoutes };
