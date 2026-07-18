const { splitIntoFragments, fallbackSceneFromFragment } = require('../shared/segmentation');

function createStoryboardController({ styles, prompts, dialogue, sceneSplit }) {
  return {
    // Deterministic scene skeleton (no LLM call): lets "Dialogue" run before any prompts exist.
    async createScenes(req, res) {
      const fragments = splitIntoFragments(req.body.scriptText, req.body.sceneCount);
      const scenes = fragments.map(fallbackSceneFromFragment);
      return res.json({ scenes });
    },
    // Splits one existing scene into N sub-scenes at AI-chosen story boundaries, preserving the
    // existing scriptFragment/narrationText verbatim (validated exactly); falls back to the
    // deterministic script-only split when the provider is unavailable or fails validation. See
    // scene-split.service.js.
    async splitScene(req, res) {
      return res.json(await sceneSplit.split({ ...req.body, tenantId: req.auth.tenantId }));
    },
    async generatePrompts(req, res) {
      const style = styles.find(req.body.styleId);
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      
      let scenes = req.body.existingScenes;
      if (!Array.isArray(scenes) || scenes.length === 0) {
        const fragments = splitIntoFragments(req.body.scriptText, req.body.sceneCount);
        scenes = fragments.map(fallbackSceneFromFragment);
      }
      
      const result = await prompts.generate({ ...req.body, scenes, style });
      return res.json({ ...result, style });
    },
    async regeneratePrompt(req, res) {
      const style = styles.find(req.body.styleId || 'basic-cartoon');
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      return res.json(await prompts.regeneratePrompt({ ...req.body, style, sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0), tenantId: req.auth.tenantId }));
    },
    async regenerateAction(req, res) {
      return res.json(await prompts.regenerateAction({ ...req.body, sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0), tenantId: req.auth.tenantId }));
    },
    async generateDialogue(req, res) {
      return res.json(await dialogue.generate(req.body));
    },
    async regenerateDialogue(req, res) {
      return res.json(await dialogue.regenerate({ ...req.body, tenantId: req.auth.tenantId }));
    },
  };
}

module.exports = { createStoryboardController };
