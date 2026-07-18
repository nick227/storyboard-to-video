const { cleanText, extractJson } = require('../shared/text');
const { providerOutput } = require('../providers/result');

function createReferenceGenerationService({ textProviders }) {
  async function generateVisualPromptFromScript({ scriptText, provider, mode }) {
    if (provider === 'stub') return 'A cartoon scene from the story.';
    let instructions = '';
    if (mode === 'character-reference') {
      instructions = 'Analyze this story and describe the visual appearance, attire, and physical traits of the main characters in 30-80 words. State only visual traits, no style wording. Return strict JSON: {"prompt": "..."}.';
    } else if (mode === 'world-reference') {
      instructions = 'Analyze this story and describe the locations, set design, environment, and general atmosphere in 30-80 words. State only visual environment details, no style wording. Return strict JSON: {"prompt": "..."}.';
    } else {
      instructions = 'Analyze this story and generate a descriptive visual scene description (Visual Prompt) in 30-80 words. State the main subjects, actions, environment, and mood. No style wording. Return strict JSON: {"prompt": "..."}.';
    }
    const request = `${instructions}\nStory:\n${scriptText}`;
    try {
      const parsed = extractJson(providerOutput(await textProviders.call(provider, request)));
      return parsed?.prompt || '';
    } catch (_) {
      return '';
    }
  }

  return { generateVisualPromptFromScript };
}

module.exports = { createReferenceGenerationService };
