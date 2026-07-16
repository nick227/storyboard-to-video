const { AppError } = require('../errors');
const { cleanText, extractJson } = require('../shared/text');

function cleanLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    speaker: cleanText(line?.speaker, 80) || 'Narrator',
    text: cleanText(line?.text, 2_000),
  })).filter((line) => line.text);
}

const fallbackLines = (scene) => [{ speaker: 'Narrator', text: cleanText(scene.beat, 2_000) || cleanText(scene.title, 200) || 'Narration.' }];

function createDialogueService({ textProviders }) {
  async function generate({ scriptText, scenes, provider, fallbackPolicy = 'local' }) {
    const fallback = scenes.map((scene, index) => ({ sceneNumber: scene.sceneNumber || index + 1, lines: fallbackLines(scene) }));
    if (provider === 'stub') return { scenesDialogue: fallback, speakers: ['Narrator'], usedFallback: true, warning: 'Stub text mode selected; local fallback dialogue was used.' };
    const prompt = `Return strict JSON {"scenes":[{"sceneNumber":1,"lines":[{"speaker":"...","text":"..."}]}]}. Produce concise voice-ready dialogue for exactly ${scenes.length} scenes. Keep recurring speaker names spelled consistently. Scenes: ${scenes.map((scene, index) => `${index + 1}. ${scene.title}: ${scene.beat}`).join('\n')}. Story: ${scriptText}`;
    try {
      const parsed = extractJson(await textProviders.call(provider, prompt));
      if (!Array.isArray(parsed?.scenes)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid dialogue data', { status: 502 });
      if (parsed.scenes.length !== scenes.length && fallbackPolicy !== 'local') throw new AppError('INCOMPLETE_PROVIDER_RESPONSE', 'The provider returned incomplete dialogue', { status: 502 });
      const scenesDialogue = fallback.map((base, index) => {
        const lines = cleanLines(parsed.scenes[index]?.lines);
        return { sceneNumber: base.sceneNumber, lines: lines.length ? lines : base.lines };
      });
      const speakers = [...new Set(scenesDialogue.flatMap((scene) => scene.lines.map((line) => line.speaker)))];
      return { scenesDialogue, speakers, usedFallback: parsed.scenes.length !== scenes.length, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { scenesDialogue: fallback, speakers: ['Narrator'], usedFallback: true, warning: `Provider unavailable; local fallback dialogue was used. ${cleanText(error.message, 300)}` };
    }
  }

  async function regenerate({ scriptText, scene, sceneIndex, provider, knownSpeakers = [], fallbackPolicy = 'local' }) {
    const fallback = fallbackLines(scene);
    if (provider === 'stub') return { lines: fallback, usedFallback: true, warning: 'Stub text mode selected; fallback dialogue was retained.' };
    const prompt = `Return strict JSON {"lines":[{"speaker":"...","text":"..."}]}. Rewrite concise voice-ready dialogue for scene ${sceneIndex + 1}. Story: ${scriptText}. Scene: ${scene.title} ${scene.beat}. Known speakers: ${knownSpeakers.join(', ') || 'none'}. Keep recurring speaker names spelled consistently.`;
    try {
      const lines = cleanLines(extractJson(await textProviders.call(provider, prompt))?.lines);
      if (!lines.length) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid dialogue data', { status: 502 });
      return { lines, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { lines: fallback, usedFallback: true, warning: `Provider unavailable; fallback dialogue was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { cleanLines, generate, regenerate };
}

module.exports = { cleanLines, createDialogueService };
