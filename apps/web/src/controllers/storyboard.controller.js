function createStoryboardController({ styles, prompts, dialogue }) {
  return {
    // Deterministic scene skeleton (no LLM call): lets "Dialogue" run before any prompts exist.
    async createScenes(req, res) {
      return res.json({ scenes: prompts.splitIntoScenes(req.body.scriptText, req.body.sceneCount) });
    },
    // Splits one existing scene's fragment into N sub-scenes, for mid-storyboard insertion.
    async splitScene(req, res) {
      return res.json({ scenes: prompts.splitSceneIntoScenes(req.body.scriptFragment, req.body.count, req.body.narrationText) });
    },
    async generatePrompts(req, res) {
      const style = styles.find(req.body.styleId);
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      const result = await prompts.generate({ ...req.body, style });
      return res.json({ ...result, style });
    },
    async regeneratePrompt(req, res) {
      const style = styles.find(req.body.styleId || 'basic-cartoon');
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      return res.json(await prompts.regenerate({ ...req.body, style, sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0), tenantId: req.auth.tenantId }));
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
