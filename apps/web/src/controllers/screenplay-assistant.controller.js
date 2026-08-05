function createScreenplayAssistantController({ screenplayAssistant }) {
  return {
    async chat(req, res) {
      return res.json(await screenplayAssistant.chat({ ...req.body, tenantId: req.auth.tenantId }));
    },
    async addLines(req, res) {
      return res.json(await screenplayAssistant.addNextLines({ ...req.body, tenantId: req.auth.tenantId }));
    },
  };
}

module.exports = { createScreenplayAssistantController };
