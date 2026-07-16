const express = require('express');
const { validate } = require('../middleware/validate');
const { promptGeneration } = require('../schemas');
const { asyncRoute } = require('./helpers');

function storyboardRoutes({ controller, idempotency, execute }) {
  const router = express.Router();
  router.post('/generate-prompts', validate(promptGeneration), idempotency, execute('prompts'), asyncRoute(controller.generatePrompts));
  router.post('/regenerate-prompt', idempotency, execute('prompt'), asyncRoute(controller.regeneratePrompt));
  router.post('/generate-dialogue', idempotency, execute('dialogue'), asyncRoute(controller.generateDialogue));
  router.post('/regenerate-dialogue', idempotency, execute('dialogue'), asyncRoute(controller.regenerateDialogue));
  return router;
}

module.exports = { storyboardRoutes };
