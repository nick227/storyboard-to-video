const { AppError } = require('../errors');
const { clampSceneCount, cleanText, extractJson, getAdditionalCommonPrompt } = require('../shared/text');

function compactWords(value, maxWords) {
  return cleanText(value, 5_000).split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}

function compactAction(value, fallback = 'Subject moves.') {
  return compactWords(value, 14) || fallback;
}

function splitIntoScenes(scriptText, sceneCount) {
  const count = clampSceneCount(sceneCount);
  const source = cleanText(scriptText, 200_000);
  let chunks = source.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/).map((item) => item.trim()).filter(Boolean);
  if (!chunks.length) chunks = ['A simple opening scene introducing the story.'];
  if (chunks.length < count) {
    const words = source.split(/\s+/).filter(Boolean);
    if (words.length >= count) chunks = Array.from({ length: count }, (_, index) => words.slice(Math.floor(index * words.length / count), Math.floor((index + 1) * words.length / count)).join(' '));
  }
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * chunks.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * chunks.length / count));
    const sourceBeat = chunks.slice(start, end).join(' ') || chunks[index % chunks.length];
    const beat = compactAction(sourceBeat);
    return {
      sceneNumber: index + 1,
      title: `Scene ${index + 1}`,
      beat,
      prompt: `${beat} Clear subject, key pose, readable composition.`,
    };
  });
}

function createPromptGenerationService({ textProviders, limits }) {
  async function generate({ scriptText, sceneCount, style, commonPromptText, provider, fallbackPolicy = 'local' }) {
    const fallback = splitIntoScenes(scriptText, sceneCount);
    if (provider === 'stub') return { scenes: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback prompts were used.' };
    const additional = getAdditionalCommonPrompt(style.promptText, commonPromptText);
    const request = `Return strict JSON only: {"scenes":[{"sceneNumber":1,"title":"...","beat":"...","prompt":"..."}]}.
Create exactly ${sceneCount} sequential storyboard scenes.

BEAT RULES:
- One concrete physical action, 3-12 words.
- Use caveman-simple present tense: named subject + strong verb + object or direction.
- One action only. No "and", "then", "while", camera language, style, emotion, motivation, or backstory.
- Prefer specific physical verbs: slams, ducks, grabs, throws, spins, kicks, points.
- Examples: "Mara kicks the door open." "Jonah drops the burning letter." "The dog lunges at the sandwich."

PROMPT RULES:
- Describe the single keyframe at the action's clearest physical moment in 15-40 words.
- State subject, pose, important object, location, and composition.
- No motion sequence, camera movement, or style wording.
- Keep recurring named characters and objects consistent across adjacent scenes.

Selected style context (do not copy into beat or prompt): ${style.promptText}.
Additional context (do not copy): ${additional || 'none'}.
Story: ${scriptText}`;
    try {
      const parsed = extractJson(await textProviders.call(provider, request));
      if (!Array.isArray(parsed?.scenes)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid scene data', { status: 502, retryable: true });
      if (parsed.scenes.length !== sceneCount && fallbackPolicy !== 'local') throw new AppError('INCOMPLETE_PROVIDER_RESPONSE', `The provider returned ${parsed.scenes.length} of ${sceneCount} scenes`, { status: 502, retryable: true });
      const scenes = fallback.map((base, index) => ({
        ...base,
        title: cleanText(parsed.scenes[index]?.title, 200) || base.title,
        beat: compactAction(parsed.scenes[index]?.beat, base.beat),
        prompt: cleanText(parsed.scenes[index]?.prompt, limits.prompt) || base.prompt,
      }));
      const usedFallback = parsed.scenes.length !== sceneCount;
      return { scenes, usedFallback, warning: usedFallback ? 'Local fallback filled missing scenes.' : '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { scenes: fallback, usedFallback: true, warning: `Provider unavailable; local fallback prompts were used. ${cleanText(error.message, 300)}` };
    }
  }

  async function regenerate({ scriptText, scene, sceneIndex, style, commonPromptText, provider, extraPromptText, fallbackPolicy = 'local' }) {
    const fallback = `${scene.prompt || ''} ${extraPromptText || ''}`.trim();
    if (provider === 'stub') return { prompt: fallback, usedFallback: true, warning: 'Stub text mode selected; the existing prompt was retained.' };
    const request = `Return strict JSON only: {"prompt":"..."}. Rewrite the Visual Prompt for storyboard frame ${sceneIndex + 1} in 15-40 words. Show this physical action at its clearest single instant: ${scene.beat || ''}. State subject, pose, important object, location, and readable composition. Do not add a sequence, camera movement, or style wording. Story: ${scriptText}. Title: ${scene.title || ''}. Existing Visual Prompt: ${scene.prompt || ''}. Note: ${extraPromptText || 'none'}. Selected style context (do not copy): ${style.promptText}. Additional context (do not copy): ${getAdditionalCommonPrompt(style.promptText, commonPromptText) || 'none'}.`;
    try {
      const value = cleanText(extractJson(await textProviders.call(provider, request))?.prompt, limits.prompt);
      if (!value) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid prompt data', { status: 502 });
      return { prompt: value, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { prompt: fallback, usedFallback: true, warning: `Provider unavailable; the existing prompt was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { compactAction, generate, regenerate, splitIntoScenes };
}

module.exports = { compactAction, createPromptGenerationService, splitIntoScenes };
