const { cleanText } = require('../shared/text');

function createStoryboardController({ styles, prompts, dialogue, config }) {
  return {
    async generatePrompts(req, res) {
      const style = styles.find(req.body.styleId);
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      const result = await prompts.generate({ ...req.body, style });
      return res.json({ ...result, style });
    },
    async regeneratePrompt(req, res) {
      const style = styles.find(req.body.styleId || 'basic-cartoon');
      if (!style) return res.status(400).json({ error: 'Unknown style' });
      return res.json(await prompts.regenerate({ ...req.body, style, sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0) }));
    },
    async regenerateAction(req, res) {
      return res.json(await prompts.regenerateAction({ ...req.body, sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0) }));
    },
    async generateDialogue(req, res) {
      if (!Array.isArray(req.body.scenes) || !req.body.scenes.length) return res.status(400).json({ error: 'Scenes are required' });
      return res.json(await dialogue.generate({ ...req.body, scriptText: cleanText(req.body.scriptText, config.limits.script) }));
    },
    async regenerateDialogue(req, res) {
      return res.json(await dialogue.regenerate({
        ...req.body,
        sceneIndex: Math.max(0, Number.parseInt(req.body.sceneIndex, 10) || 0),
        knownSpeakers: Array.isArray(req.body.knownSpeakers) ? req.body.knownSpeakers.slice(0, 50) : [],
      }));
    },
  };
}

module.exports = { createStoryboardController };
