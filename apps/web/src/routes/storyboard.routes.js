const express = require('express');
const { validate } = require('../middleware/validate');
const { planShots, regenerateAction, regenerateDialogue, regeneratePrompt, splitScene } = require('../schemas');
const { asyncRoute } = require('./helpers');

function storyboardRoutes({ controller, idempotency, execute }) {
  const router = express.Router();
  router.post('/plan-shots', validate(planShots), idempotency, execute('scenes'), asyncRoute(controller.planShots));
  router.post('/split-scene', validate(splitScene), idempotency, execute('scenes'), asyncRoute(controller.splitScene));
  router.post('/regenerate-prompt', validate(regeneratePrompt), idempotency, execute('prompt'), asyncRoute(controller.regeneratePrompt));
  router.post('/regenerate-action', validate(regenerateAction), idempotency, execute('action'), asyncRoute(controller.regenerateAction));
  router.post('/regenerate-dialogue', validate(regenerateDialogue), idempotency, execute('dialogue'), asyncRoute(controller.regenerateDialogue));
  return router;
}

module.exports = { storyboardRoutes };
