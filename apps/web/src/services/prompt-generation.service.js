const { AppError } = require('../errors');
const { clampSceneCount, cleanText, extractJson, getAdditionalCommonPrompt } = require('../shared/text');
const { chunk, neighborContextBlock } = require('../shared/batching');
const { providerOutput } = require('../providers/result');

const PROMPT_BATCH_SIZE = 5;
const FRAGMENT_MAX_LENGTH = 20_000;

// Bump whenever BEAT_RULES/the regeneratePrompt()/regenerateAction() request text changes meaningfully —
// invalidates old exact-input cache entries so a prompt-quality improvement can't silently keep
// serving pre-improvement results forever.
const PROMPT_TEMPLATE_VERSION = 1;
const ACTION_TEMPLATE_VERSION = 1;

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

function createRecapTracker() {
  let lastBeat = '';
  return {
    update(batchScenes) {
      lastBeat = batchScenes[batchScenes.length - 1]?.beat || lastBeat;
    },
    describe() {
      if (!lastBeat) return null;
      return { lastBeat };
    },
  };
}

// Deterministically slices the raw script into up to `sceneCount` fragments. This split is
// authoritative: it happens once, before any AI call, and every downstream generation/regeneration
// call is scoped to a scene's own fragment (plus small neighbor context) — the AI never sees text
// outside its assigned fragment(s), so an AI-invented scene boundary can never disagree with this one.
//
// The returned array can be SHORTER than `sceneCount` when the source text can't support that many
// distinct pieces — every fragment maps to a non-empty, non-overlapping slice of `chunks`, so this
// never wraps around and duplicates a chunk across multiple fragments. Callers must use the actual
// returned length, not assume it always equals the requested `sceneCount`.
function splitIntoFragments(scriptText, sceneCount) {
  const count = clampSceneCount(sceneCount);
  const source = cleanText(scriptText, 200_000);
  if (!source) return [];

  let chunks = source.split(/\r?\n+/).map((item) => item.trim()).filter(Boolean);
  if (!chunks.length) return [];

  if (chunks.length < count) {
    const words = source.split(/\s+/).filter(Boolean);
    if (words.length >= count) {
      chunks = Array.from({ length: count }, (_, index) =>
        words.slice(Math.floor(index * words.length / count), Math.floor((index + 1) * words.length / count)).join(' ')
      );
    } else if (words.length > chunks.length) {
      chunks = words;
    }
  }

  const achievableCount = Math.min(count, chunks.length);
  return Array.from({ length: achievableCount }, (_, index) => {
    const start = Math.floor(index * chunks.length / achievableCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * chunks.length / achievableCount));
    const scriptFragment = cleanText(chunks.slice(start, end).join(' '), FRAGMENT_MAX_LENGTH);
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
    // Server-authored provenance (see prompt-generation.service.js callers): this synthetic
    // prompt/beat pair always co-varies, so staleness comparison (beat vs promptGeneratedFromBeat)
    // starts consistent even before any real AI generation has happened.
    promptGeneratedFromBeat: beat,
  };
}

// Splitting one existing scene into sub-scenes (mid-storyboard expansion): the scene's own
// scriptFragment is the default, authoritative source.
function splitSceneIntoScenes(scriptFragment, count, narrationText) {
  const splitAndMap = (text, n) => splitIntoFragments(text, n).map(fallbackSceneFromFragment);
  const fromFragment = splitAndMap(scriptFragment, count);
  if (fromFragment.length >= count || !narrationText) return fromFragment;
  const fromNarration = splitAndMap(narrationText, count);
  return fromNarration.length > fromFragment.length ? fromNarration : fromFragment;
}

// Keep scriptFragment as the grounding source; optionally use valid enriched narration as the primary visual source.
// Simplified into a neutral buildSceneSourceContext without claims like “richer.”
function buildSceneSourceContext(fragment, enrich) {
  const hasNarration = enrich && fragment.narrationText && !fragment.narrationIsFallback;
  if (hasNarration) {
    return `Narration: ${cleanText(fragment.narrationText, 6_000)}\nScript fragment: ${fragment.scriptFragment}`;
  }
  return fragment.scriptFragment;
}

function buildBatchRequest({ batchFragments, batchStartIndex, sceneCount, style, additional, recap, enrich }) {
  const scenesBlock = batchFragments
    .map((fragment, i) => `${batchStartIndex + i + 1}. ${buildSceneSourceContext(fragment, enrich)}`)
    .join('\n\n');
  const recapBlock = recap
    ? `Continuity: previous scene's action: "${recap.lastBeat}".`
    : 'No prior continuity.';

  return `Return strict JSON only: {"scenes":[{"sceneNumber":N,"title":"...","beat":"...","prompt":"..."}]}.
Create storyboard scenes ${batchStartIndex + 1}-${batchStartIndex + batchFragments.length} of ${sceneCount} total sequential scenes, exactly one object per source block listed below, using ONLY that block's own text as the source for that scene's beat and prompt.

${recapBlock}

${BEAT_RULES}

PROMPT RULES:
- Describe the single keyframe at the action's clearest physical moment in 15-40 words.
- State subject, pose, important object, location, and composition.
- No motion sequence, camera movement, or style wording.
- ${CONTINUITY_RULE}

Selected style context (do not copy into beat or prompt): ${style.promptText}.
Additional context (do not copy): ${additional || 'none'}.

Scene sources (each numbered block is the ONLY source text for that scene's beat and prompt):
${scenesBlock}`;
}

function createPromptGenerationService({ textProviders, limits, generationCache }) {
  async function generate({ scriptText, sceneCount, style, commonPromptText, provider, fallbackPolicy = 'local', existingScenes, enrich = true }) {
    // A dialogue-first run already produced scenes with their own scriptFragment (and possibly
    // narrationText) via createSceneSkeleton/generateDialogue — reuse those instead of re-splitting
    // the script from scratch, so prompt generation lands on the exact same scene boundaries.
    const useExisting = Array.isArray(existingScenes) && existingScenes.length > 0;
    const count = useExisting ? existingScenes.length : clampSceneCount(sceneCount);
    const fragments = useExisting
      ? existingScenes.map((scene, index) => ({ sceneNumber: scene.sceneNumber || index + 1, scriptFragment: scene.scriptFragment || '', narrationText: scene.narrationText || '', narrationIsFallback: Boolean(scene.narrationIsFallback) }))
      : splitIntoFragments(scriptText, count);
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
      const request = buildBatchRequest({ batchFragments, batchStartIndex, sceneCount: fragments.length, style, additional, recap: recap.describe(), enrich });
      try {
        const parsed = extractJson(providerOutput(await textProviders.call(provider, request)));
        if (!Array.isArray(parsed?.scenes)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid scene data', { status: 502, retryable: true });
        if (parsed.scenes.length !== batchFragments.length && fallbackPolicy !== 'local') {
          throw new AppError('INCOMPLETE_PROVIDER_RESPONSE', `The provider returned ${parsed.scenes.length} of ${batchFragments.length} scenes for batch ${b + 1}`, { status: 502, retryable: true });
        }
        const batchScenes = batchFragments.map((fragment, i) => {
          const base = fallback[batchStartIndex + i];
          const item = parsed.scenes[i];
          const beat = compactAction(item?.beat, base.beat);
          // Provenance is stamped server-side, from what THIS request actually used as source —
          // never client-inferred — so staleness survives reloads/concurrent tabs/interrupted clients.
          const usedNarrationSource = enrich && Boolean(fragment.narrationText) && !fragment.narrationIsFallback;
          return {
            ...base,
            title: cleanText(item?.title, 200) || base.title,
            beat,
            prompt: cleanText(item?.prompt, limits.prompt) || base.prompt,
            promptGeneratedFromBeat: beat,
            promptGeneratedFromNarration: usedNarrationSource ? fragment.narrationText : null,
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

  async function regeneratePrompt({ scene, sceneIndex, previousBeat = '', nextBeat = '', style, commonPromptText, provider, extraPromptText, fallbackPolicy = 'local', enrich = true, tenantId, bypassCache = false }) {
    const fallback = `${scene.prompt || ''} ${extraPromptText || ''}`.trim();
    if (provider === 'stub') return { prompt: fallback, usedFallback: true, warning: 'Stub text mode selected; the existing prompt was retained.' };

    const source = cleanText(scene?.scriptFragment, FRAGMENT_MAX_LENGTH);
    if (!source) throw new AppError('SCENE_FRAGMENT_MISSING', 'Scene has no script fragment', { status: 400 });
    const usedNarrationSource = enrich && Boolean(scene?.narrationText) && !scene?.narrationIsFallback;
    const sourceBlock = usedNarrationSource
      ? `Narration: ${cleanText(scene.narrationText, 6_000)}.\nScript fragment: ${source}`
      : `Scene script excerpt (use ONLY this text as source): ${source}`;

    // Exact-input reuse: only for this single-scene regenerate, never the bulk batch generate() above.
    const fingerprintInput = tenantId ? {
      tenantId, operation: 'prompt.regenerate', provider, promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      source: JSON.stringify({
        source,
        sceneIndex,
        title: scene.title || '',
        beat: scene.beat || '',
        existingPrompt: scene.prompt || '',
        usedNarrationSource,
        narrationText: usedNarrationSource ? scene.narrationText : '',
        previousBeat,
        nextBeat,
        extraPromptText,
        styleId: style.id,
        stylePromptText: style.promptText || '',
        commonPromptText,
      }),
      settings: { enrich },
    } : null;
    if (fingerprintInput && generationCache && !bypassCache) {
      const cached = await generationCache.lookup(fingerprintInput);
      if (cached) return { ...cached.result, cacheHit: true };
    }

    const neighborBlock = neighborContextBlock(previousBeat, nextBeat);
    const request = `Return strict JSON only: {"prompt":"..."}. Rewrite the Visual Prompt for storyboard frame ${sceneIndex + 1} in 15-40 words. Show this physical action at its clearest single instant: ${scene.beat || ''}. State subject, pose, important object, location, and readable composition. Do not add a sequence, camera movement, or style wording. ${CONTINUITY_RULE}${neighborBlock ? ` ${neighborBlock}` : ''} ${sourceBlock}. Title: ${scene.title || ''}. Existing Visual Prompt: ${scene.prompt || ''}. Note: ${extraPromptText || 'none'}. Selected style context (do not copy): ${style.promptText}. Additional context (do not copy): ${getAdditionalCommonPrompt(style.promptText, commonPromptText) || 'none'}.`;
    // Provenance reflects what THIS regeneration actually used as source — only stamped on a real
    // (non-fallback) result, mirroring the pre-existing client rule of only updating
    // promptGeneratedFromBeat when `!usedFallback`. A fallback response omits these fields entirely
    // so the caller keeps whatever provenance the scene already had (the prompt itself didn't change).
    try {
      const value = cleanText(extractJson(providerOutput(await textProviders.call(provider, request)))?.prompt, limits.prompt);
      if (!value) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid prompt data', { status: 502 });
      const result = {
        prompt: value,
        usedFallback: false,
        warning: '',
        promptGeneratedFromBeat: scene.beat || '',
        promptGeneratedFromNarration: usedNarrationSource ? scene.narrationText : null,
      };
      if (fingerprintInput && generationCache) await generationCache.record(fingerprintInput, result, { bypassed: bypassCache });
      return result;
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { prompt: fallback, usedFallback: true, warning: `Provider unavailable; the existing prompt was retained. ${cleanText(error.message, 300)}` };
    }
  }

  async function regenerateAction({ scene, sceneIndex, previousBeat = '', nextBeat = '', provider, fallbackPolicy = 'local', tenantId, bypassCache = false }) {
    const source = cleanText(scene?.scriptFragment, FRAGMENT_MAX_LENGTH);
    const fallback = compactAction(source, scene?.beat || 'Subject moves.');

    if (provider === 'stub') return { beat: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback action was used.' };
    if (!source) throw new AppError('SCENE_FRAGMENT_MISSING', 'Scene has no script fragment', { status: 400 });

    const fingerprintInput = tenantId ? {
      tenantId, operation: 'action.regenerate', provider, promptTemplateVersion: ACTION_TEMPLATE_VERSION,
      source: JSON.stringify({ source, sceneIndex, previousBeat, nextBeat, existingBeat: scene?.beat || '' }),
    } : null;
    if (fingerprintInput && generationCache && !bypassCache) {
      const cached = await generationCache.lookup(fingerprintInput);
      if (cached) return { ...cached.result, cacheHit: true };
    }

    const neighborBlock = neighborContextBlock(previousBeat, nextBeat);
    const request = `Return strict JSON only: {"beat":"..."}. Rewrite the physical action (Beat) for storyboard scene ${sceneIndex + 1} in 5-24 words.
${BEAT_RULES}
- Keep recurring named characters and objects consistent with neighboring scenes.
${neighborBlock}
This scene's exact script excerpt (use ONLY this text as the source of the action): ${source}
Existing action (for reference, may be replaced): ${scene?.beat || 'none'}.`;
    try {
      const value = compactAction(extractJson(providerOutput(await textProviders.call(provider, request)))?.beat, '');
      if (!value) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid action data', { status: 502 });
      const result = { beat: value, usedFallback: false, warning: '' };
      if (fingerprintInput && generationCache) await generationCache.record(fingerprintInput, result, { bypassed: bypassCache });
      return result;
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { beat: fallback, usedFallback: true, warning: `Provider unavailable; the existing action was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { compactAction, generate, regeneratePrompt, regenerateAction, splitIntoFragments, splitSceneIntoScenes, fallbackSceneFromFragment };
}

module.exports = { compactAction, createPromptGenerationService, fallbackSceneFromFragment, splitIntoFragments, splitSceneIntoScenes };
