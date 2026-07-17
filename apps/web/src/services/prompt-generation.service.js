const { AppError } = require('../errors');
const { clampSceneCount, cleanText, extractJson, getAdditionalCommonPrompt } = require('../shared/text');
const { providerOutput } = require('../providers/result');

const PROMPT_BATCH_SIZE = 5;
const FRAGMENT_MAX_LENGTH = 20_000;
const RECAP_NAME_CAP = 15;
const NEIGHBOR_BEAT_MAX_LENGTH = 300;
const BEAT_STOPWORDS = new Set(['The', 'A', 'An', 'This', 'That', 'These', 'Those', 'It', 'He', 'She', 'They', 'His', 'Her', 'Their', 'Its']);

const BEAT_RULES = `BEAT RULES:
- One primary physical action, usually 5-20 words; never more than 24 words.
- Use caveman-simple present tense: named subject + strong verb + object or direction.
- A short second clause may show the immediate visible result or physical reaction.
- Avoid conjunction chains, camera language, style, emotion, motivation, or backstory.
- Prefer specific physical verbs: slams, ducks, grabs, throws, spins, kicks, points.
- Examples: "Mara kicks the door; wood splinters outward." "Jonah drops the letter; flames scatter across the floor." "The dog lunges at the sandwich."`;

const CONTINUITY_RULE = 'Keep recurring named characters and objects consistent across adjacent scenes.';

function compactWords(value, maxWords) {
  return cleanText(value, 5_000).split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}

function compactAction(value, fallback = 'Subject moves.') {
  return compactWords(value, 24) || fallback;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function extractNames(text) {
  return (String(text || '').match(/\b[A-Z][a-zA-Z'-]{1,}\b/g) || []).filter((word) => !BEAT_STOPWORDS.has(word));
}

function createRecapTracker() {
  const names = new Set();
  let lastBeat = '';
  return {
    update(batchScenes) {
      batchScenes.forEach((scene) => extractNames(scene.beat).forEach((name) => names.add(name)));
      lastBeat = batchScenes[batchScenes.length - 1]?.beat || lastBeat;
    },
    describe() {
      if (!lastBeat && !names.size) return null;
      return { lastBeat, recurringNames: [...names].slice(-RECAP_NAME_CAP) };
    },
  };
}

function neighborContextBlock(previousBeat, nextBeat) {
  const parts = [
    previousBeat ? `Previous scene's action: ${cleanText(previousBeat, NEIGHBOR_BEAT_MAX_LENGTH)}.` : '',
    nextBeat ? `Next scene's action: ${cleanText(nextBeat, NEIGHBOR_BEAT_MAX_LENGTH)}.` : '',
  ].filter(Boolean).join(' ');
  return parts ? `Neighboring context for continuity only (do not copy verbatim): ${parts}` : '';
}

// Deterministically slices the raw script into `sceneCount` fragments. This split is authoritative:
// it happens once, before any AI call, and every downstream generation/regeneration call is scoped
// to a scene's own fragment (plus small neighbor context) — the AI never sees text outside its
// assigned fragment(s), so an AI-invented scene boundary can never disagree with this one.
function splitIntoFragments(scriptText, sceneCount) {
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
    const scriptFragment = cleanText(chunks.slice(start, end).join(' ') || chunks[index % chunks.length], FRAGMENT_MAX_LENGTH);
    return { sceneNumber: index + 1, scriptFragment };
  });
}

function fallbackSceneFromFragment(fragment, index) {
  const beat = compactAction(fragment.scriptFragment);
  return {
    sceneNumber: fragment.sceneNumber,
    title: `Scene ${index + 1}`,
    scriptFragment: fragment.scriptFragment,
    beat,
    prompt: `${beat} Clear subject, key pose, readable composition.`,
  };
}

// Kept for backward compatibility: server.js re-exports this, and test/server.test.js calls it
// directly. Equivalent to splitting into fragments and immediately compacting each into a scene.
function splitIntoScenes(scriptText, sceneCount) {
  return splitIntoFragments(scriptText, sceneCount).map(fallbackSceneFromFragment);
}

function buildBatchRequest({ batchFragments, batchStartIndex, sceneCount, style, additional, recap }) {
  const scenesBlock = batchFragments
    .map((fragment, i) => `${batchStartIndex + i + 1}. ${fragment.scriptFragment}`)
    .join('\n\n');
  const recapBlock = recap
    ? `Continuity carried from earlier scenes — do not restate, just stay consistent: previous scene's action: "${recap.lastBeat}". Recurring named characters/objects so far: ${recap.recurringNames.join(', ') || 'none noted yet'}.`
    : 'This is the first batch of scenes; there is no prior continuity yet.';
  return `Return strict JSON only: {"scenes":[{"sceneNumber":N,"title":"...","beat":"...","prompt":"..."}]}.
Create storyboard scenes ${batchStartIndex + 1}-${batchStartIndex + batchFragments.length} of ${sceneCount} total sequential scenes, exactly one object per fragment listed below, using ONLY that fragment's own text as the source for that scene's beat and prompt.

${recapBlock}

${BEAT_RULES}
- Keep recurring named characters and objects (per the continuity note above) consistent with earlier scenes.

PROMPT RULES:
- Describe the single keyframe at the action's clearest physical moment in 15-40 words.
- State subject, pose, important object, location, and composition.
- No motion sequence, camera movement, or style wording.
- ${CONTINUITY_RULE}

Selected style context (do not copy into beat or prompt): ${style.promptText}.
Additional context (do not copy): ${additional || 'none'}.

Scene fragments (each numbered fragment is the ONLY source text for that scene's beat and prompt):
${scenesBlock}`;
}

function createPromptGenerationService({ textProviders, limits }) {
  async function generate({ scriptText, sceneCount, style, commonPromptText, provider, fallbackPolicy = 'local' }) {
    const count = clampSceneCount(sceneCount);
    const fragments = splitIntoFragments(scriptText, count);
    const fallback = fragments.map(fallbackSceneFromFragment);
    if (provider === 'stub') return { scenes: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback prompts were used.' };

    const additional = getAdditionalCommonPrompt(style.promptText, commonPromptText);
    const batches = chunk(fragments, PROMPT_BATCH_SIZE);
    const scenes = new Array(fragments.length);
    const recap = createRecapTracker();
    let anyFallbackUsed = false;
    const warnings = [];

    // Batches run sequentially (not Promise.all) so each batch's request can carry forward the
    // real recap from the previous batch's actual output — parallelizing would trade that
    // cross-batch continuity for a faster wall clock, which isn't the tradeoff we want here.
    for (let b = 0; b < batches.length; b += 1) {
      const batchFragments = batches[b];
      const batchStartIndex = b * PROMPT_BATCH_SIZE;
      const request = buildBatchRequest({ batchFragments, batchStartIndex, sceneCount: count, style, additional, recap: recap.describe() });
      try {
        const parsed = extractJson(providerOutput(await textProviders.call(provider, request)));
        if (!Array.isArray(parsed?.scenes)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid scene data', { status: 502, retryable: true });
        if (parsed.scenes.length !== batchFragments.length && fallbackPolicy !== 'local') {
          throw new AppError('INCOMPLETE_PROVIDER_RESPONSE', `The provider returned ${parsed.scenes.length} of ${batchFragments.length} scenes for batch ${b + 1}`, { status: 502, retryable: true });
        }
        const batchScenes = batchFragments.map((_fragment, i) => {
          const base = fallback[batchStartIndex + i];
          const item = parsed.scenes[i];
          return {
            ...base,
            title: cleanText(item?.title, 200) || base.title,
            beat: compactAction(item?.beat, base.beat),
            prompt: cleanText(item?.prompt, limits.prompt) || base.prompt,
          };
        });
        batchScenes.forEach((scene, i) => { scenes[batchStartIndex + i] = scene; });
        if (parsed.scenes.length !== batchFragments.length) anyFallbackUsed = true;
        recap.update(batchScenes);
      } catch (error) {
        if (fallbackPolicy !== 'local') throw error;
        const batchFallback = batchFragments.map((_fragment, i) => fallback[batchStartIndex + i]);
        batchFallback.forEach((scene, i) => { scenes[batchStartIndex + i] = scene; });
        anyFallbackUsed = true;
        warnings.push(`Scenes ${batchStartIndex + 1}-${batchStartIndex + batchFragments.length}: provider unavailable, local fallback used. ${cleanText(error.message, 200)}`);
        recap.update(batchFallback);
      }
    }

    return { scenes, usedFallback: anyFallbackUsed, warning: warnings.join(' ') || (anyFallbackUsed ? 'Local fallback filled some scenes.' : '') };
  }

  async function regenerate({ scriptText, scene, sceneIndex, previousBeat = '', nextBeat = '', style, commonPromptText, provider, extraPromptText, fallbackPolicy = 'local' }) {
    const fallback = `${scene.prompt || ''} ${extraPromptText || ''}`.trim();
    if (provider === 'stub') return { prompt: fallback, usedFallback: true, warning: 'Stub text mode selected; the existing prompt was retained.' };

    const legacy = !scene?.scriptFragment;
    const source = cleanText(legacy ? scriptText : scene.scriptFragment, legacy ? 200_000 : FRAGMENT_MAX_LENGTH);
    if (!source) throw new AppError('SCENE_FRAGMENT_MISSING', 'Scene has no script fragment and no script text was provided to regenerate its prompt', { status: 400 });

    const neighborBlock = neighborContextBlock(previousBeat, nextBeat);
    const request = `Return strict JSON only: {"prompt":"..."}. Rewrite the Visual Prompt for storyboard frame ${sceneIndex + 1} in 15-40 words. Show this physical action at its clearest single instant: ${scene.beat || ''}. State subject, pose, important object, location, and readable composition. Do not add a sequence, camera movement, or style wording. ${CONTINUITY_RULE}${neighborBlock ? ` ${neighborBlock}` : ''} ${legacy ? 'Story' : "Scene script excerpt (use ONLY this text as source)"}: ${source}. Title: ${scene.title || ''}. Existing Visual Prompt: ${scene.prompt || ''}. Note: ${extraPromptText || 'none'}. Selected style context (do not copy): ${style.promptText}. Additional context (do not copy): ${getAdditionalCommonPrompt(style.promptText, commonPromptText) || 'none'}.`;
    try {
      const value = cleanText(extractJson(providerOutput(await textProviders.call(provider, request)))?.prompt, limits.prompt);
      if (!value) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid prompt data', { status: 502 });
      return { prompt: value, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { prompt: fallback, usedFallback: true, warning: `Provider unavailable; the existing prompt was retained. ${cleanText(error.message, 300)}` };
    }
  }

  async function regenerateAction({ scriptText, scene, sceneIndex, previousBeat = '', nextBeat = '', provider, fallbackPolicy = 'local' }) {
    const legacy = !scene?.scriptFragment;
    const source = cleanText(legacy ? scriptText : scene?.scriptFragment, legacy ? 200_000 : FRAGMENT_MAX_LENGTH);
    const fallback = compactAction(source, scene?.beat || 'Subject moves.');

    if (provider === 'stub') return { beat: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback action was used.' };
    if (!source) throw new AppError('SCENE_FRAGMENT_MISSING', 'Scene has no script fragment and no script text was provided to regenerate its action', { status: 400 });

    const neighborBlock = neighborContextBlock(previousBeat, nextBeat);
    const request = `Return strict JSON only: {"beat":"..."}. Rewrite the physical action (Beat) for storyboard scene ${sceneIndex + 1} in 5-24 words.
${BEAT_RULES}
- Keep recurring named characters and objects consistent with neighboring scenes.
${neighborBlock}
${legacy ? "Full story (this scene's exact excerpt is unavailable; use the whole story for context but keep the action scoped to this scene's described moment)" : "This scene's exact script excerpt (use ONLY this text as the source of the action)"}: ${source}
Existing action (for reference, may be replaced): ${scene?.beat || 'none'}.`;
    try {
      const value = compactAction(extractJson(providerOutput(await textProviders.call(provider, request)))?.beat, '');
      if (!value) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid action data', { status: 502 });
      return { beat: value, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { beat: fallback, usedFallback: true, warning: `Provider unavailable; the existing action was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { compactAction, generate, regenerate, regenerateAction, splitIntoFragments, splitIntoScenes };
}

module.exports = { compactAction, createPromptGenerationService, fallbackSceneFromFragment, splitIntoFragments, splitIntoScenes };
