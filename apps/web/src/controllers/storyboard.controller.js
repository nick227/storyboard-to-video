const { narrationPromptDefaults } = require('../services/dialogue.service');

function createStoryboardController({ styles, prompts, dialogue, sceneSplit, shotPlanning }) {
  return {
    narrationPrompts(_req, res) {
      return res.json({ prompts: narrationPromptDefaults() });
    },
    // DEPRECATED: do not extend. Prefer prepare-narration + plan-visuals. Kept for tests/old clients.
    async planShots(req, res) {
      const style = await styles.resolve(req.body.styleId || 'basic-cartoon', req.auth.userId);
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      const result = await shotPlanning.plan({ ...req.body, style, tenantId: req.auth.tenantId });
      return res.json({ ...result, style });
    },
    async prepareNarration(req, res) {
      const style = await styles.resolve(req.body.styleId || 'basic-cartoon', req.auth.userId);
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      return res.json(await shotPlanning.prepareNarration({ ...req.body, style, tenantId: req.auth.tenantId }));
    },
    async planVisuals(req, res) {
      const style = await styles.resolve(req.body.styleId || 'basic-cartoon', req.auth.userId);
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      const result = await shotPlanning.planVisuals({ ...req.body, style, tenantId: req.auth.tenantId });
      return res.json({ ...result, style });
    },
    // Splits one existing scene into N sub-scenes at AI-chosen story boundaries, preserving the
    // existing scriptFragment/narrationText verbatim (validated exactly); falls back to the
    // deterministic script-only split when the provider is unavailable or fails validation. See
    // scene-split.service.js.
    async splitScene(req, res) {
      return res.json(await sceneSplit.split({ ...req.body, tenantId: req.auth.tenantId }));
    },
    async regeneratePrompt(req, res) {
      const style = await styles.resolve(req.body.styleId || 'basic-cartoon', req.auth.userId);
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      return res.json(await prompts.regeneratePrompt({ ...req.body, style, sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0), tenantId: req.auth.tenantId }));
    },
    async regenerateAction(req, res) {
      return res.json(await prompts.regenerateAction({ ...req.body, sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0), tenantId: req.auth.tenantId }));
    },
    async regenerateDialogue(req, res) {
      return res.json(await dialogue.regenerate({ ...req.body, tenantId: req.auth.tenantId }));
    },
  };
}

module.exports = { createStoryboardController };
