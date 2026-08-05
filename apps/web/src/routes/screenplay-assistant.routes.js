const express = require('express');
const { validate } = require('../middleware/validate');
const { assistantChat, assistantAddLines } = require('../schemas');
const { asyncRoute } = require('./helpers');

// Uses idempotency + generationTrace, NOT execute()/queue.add() -- these are meant to feel instant
// (a chat reply, a short continuation), and the app's GenerationQueue is a single global lane shared
// with slow image/video batch jobs (default concurrency 1, see config.generationConcurrency). Routing
// through it would queue a chat message behind an in-flight image batch. generationTrace still opens
// the usage-tracking context (usageTracker.execute) without ever calling queue.add().
function screenplayAssistantRoutes({ controller, idempotency, generationTrace }) {
  const router = express.Router();
  router.post('/chat', validate(assistantChat), idempotency, generationTrace, asyncRoute(controller.chat));
  router.post('/add-lines', validate(assistantAddLines), idempotency, generationTrace, asyncRoute(controller.addLines));
  return router;
}

module.exports = { screenplayAssistantRoutes };
