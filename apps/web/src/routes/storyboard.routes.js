const express = require('express');
const { validate } = require('../middleware/validate');
const { promptGeneration, regenerateAction, regeneratePrompt } = require('../schemas');
const { asyncRoute } = require('./helpers');

function storyboardRoutes({ controller, idempotency, execute }) {
  const router = express.Router();
  router.post('/generate-prompts', validate(promptGeneration), idempotency, execute('prompts'), asyncRoute(controller.generatePrompts));
  router.post('/regenerate-prompt', validate(regeneratePrompt), idempotency, execute('prompt'), asyncRoute(controller.regeneratePrompt));
  router.post('/regenerate-action', validate(regenerateAction), idempotency, execute('action'), asyncRoute(controller.regenerateAction));
  router.post('/generate-dialogue', idempotency, execute('dialogue'), asyncRoute(controller.generateDialogue));
  router.post('/regenerate-dialogue', idempotency, execute('dialogue'), asyncRoute(controller.regenerateDialogue));
  return router;
}

module.exports = { storyboardRoutes };
