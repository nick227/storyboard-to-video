const { AppError } = require('../errors');
const { cleanText, extractJson, getAdditionalCommonPrompt, compactAction } = require('../shared/text');
const { splitIntoFragments } = require('../shared/segmentation');
const { providerOutput } = require('../providers/result');
const { narrationRules, sourceOfTruthRule, cleanNarrationText, fallbackNarrationText } = require('./dialogue.service');

// Model-safe sizing for the two chunking passes below. Both reuse splitIntoFragments (paragraph-
// preferring, falls back to sentence splitting) purely as a size-based chunker -- pass it a target
// count derived from word count instead of a user-chosen scene count.
const MAX_WORDS_PER_NARRATION_CHUNK = 900;
const MAX_WORDS_PER_SHOT_CHUNK = 300; // smaller than the narration chunk: action-dense text can emit many shot objects per call, which is an output-token risk, not an input one.

const NARRATION_CHUNK_MAX_LENGTH = 6_000; // per-call output cap, same bound dialogue.service.js already uses per scene; the aggregate narration has no cap since it's built from many bounded calls.

const SHOT_RULES = `SHOT RULES:
- Break this narration excerpt into shots. Each shot pairs one still visual moment with the exact narration spoken during it.
- narrationText must be an exact copied excerpt of the narration below -- never rewritten, paraphrased, or summarized.
- One shot may cover several sentences of calm narration; a burst of fast action may need several shots for only a few words. Let the content decide -- there is no target count.
- Shots must stay in narration order and, concatenated, read back to approximately the full excerpt below.
- visualPrompt: describe the keyframe at the clearest physical moment in 15-40 words. State subject, pose, important object, location, and composition. No motion, camera movement, or style wording.
- actionPrompt: describe one physical action in 5-20 words, simple present tense: subject + verb + object/direction.`;

function wordCount(text) {
  return String(text || '').match(/\S+/g)?.length || 0;
}

// Splits `text` into pieces of at most `maxWords`, by computing the fragment count
// splitIntoFragments needs to hit that target -- one deterministic chunker, two call sites below.
function chunkByWords(text, maxWords) {
  const total = wordCount(text);
  if (!total) return [];
  const count = Math.max(1, Math.ceil(total / maxWords));
  return splitIntoFragments(text, count).map((fragment) => fragment.scriptFragment);
}

function fallbackShotsForChunk(chunkText) {
  const pieces = chunkByWords(chunkText, MAX_WORDS_PER_SHOT_CHUNK) || [chunkText];
  return (pieces.length ? pieces : [chunkText]).map((piece) => {
    const actionPrompt = compactAction(piece);
    return {
      narrationText: cleanText(piece, NARRATION_CHUNK_MAX_LENGTH),
      visualPrompt: `${actionPrompt} Clear subject, key pose, readable composition.`,
      actionPrompt,
    };
  });
}

function buildNarrateChunkRequest({ chunkText, enrich }) {
  return `Return strict JSON only: {"narrationText":"..."}. Narrate this script excerpt as continuous spoken narration.

${sourceOfTruthRule(enrich)}

${narrationRules(enrich)}

Script excerpt:
${chunkText}`;
}

function buildSequenceScanRequest({ narrationText }) {
  return `Return strict JSON only: {"sequences":[{"label":"...","intent":"..."}]}. Identify the broad narrative sequences in this narration, in order -- major beats, location/time shifts, or shifts in dramatic intent. Do not identify individual scenes, shots, or count anything; a short narration may have just one sequence.

Narration:
${narrationText}`;
}

function buildShotPlanningRequest({ chunkText, sequenceContext, style, additional }) {
  return `Return strict JSON only: {"shots":[{"narrationText":"...","visualPrompt":"...","actionPrompt":"..."}]}.

${SHOT_RULES}

Story so far (broad sequence context, for tone only -- do not restate or count these): ${sequenceContext || 'none'}

Style context: ${style?.promptText || 'none'}.
Additional: ${additional || 'none'}.

Narration excerpt to plan shots for:
${chunkText}`;
}

function createShotPlanningService({ textProviders, generationCache }) {
  async function narrateScript({ scriptText, provider, enrich, fallbackPolicy, tenantId, bypassCache }) {
    const source = cleanText(scriptText, 200_000);
    if (!source) return { narrationText: '', usedFallback: false, warning: '' };

    if (provider === 'stub') {
      return { narrationText: fallbackNarrationText({ beat: compactAction(source) }), usedFallback: true, warning: 'Stub text mode selected; local fallback narration was used.' };
    }

    const chunks = chunkByWords(source, MAX_WORDS_PER_NARRATION_CHUNK);
    const narrated = [];
    let usedFallback = false;
    const warnings = [];

    for (const chunkText of chunks) {
      const generateFn = async () => {
        const request = buildNarrateChunkRequest({ chunkText, enrich });
        const parsed = extractJson(providerOutput(await textProviders.call(provider, request)));
        const narrationText = cleanNarrationText(parsed?.narrationText);
        if (!narrationText) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned empty narration data', { status: 502 });
        return narrationText;
      };
      try {
        const result = generationCache
          ? await generationCache.runCached({
              tenantId, operation: 'narration.plan', provider, promptTemplateVersion: 1,
              source: { chunkText }, settings: { enrich }, bypassCache, generateFn,
            })
          : await generateFn();
        narrated.push(result);
      } catch (error) {
        if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid narration data', { status: 502, cause: error }));
        usedFallback = true;
        narrated.push(fallbackNarrationText({ beat: compactAction(chunkText) }));
        warnings.push(`Narration: provider unavailable for one excerpt, local fallback narration was used. ${cleanText(error.message, 200)}`);
      }
    }

    return { narrationText: narrated.join('\n\n'), usedFallback, warning: warnings.join(' ') };
  }

  async function scanSequences({ narrationText, provider, fallbackPolicy, tenantId, bypassCache }) {
    const fallback = [{ label: 'Full narration', intent: '' }];
    if (!narrationText || provider === 'stub') return fallback;

    const generateFn = async () => {
      const request = buildSequenceScanRequest({ narrationText: cleanText(narrationText, 200_000) });
      const parsed = extractJson(providerOutput(await textProviders.call(provider, request)));
      const sequences = Array.isArray(parsed?.sequences) ? parsed.sequences : null;
      if (!sequences?.length) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid sequence data', { status: 502 });
      return sequences.map((item) => ({ label: cleanText(item?.label, 200), intent: cleanText(item?.intent, 400) }));
    };

    try {
      return generationCache
        ? await generationCache.runCached({
            tenantId, operation: 'sequence.scan', provider, promptTemplateVersion: 1,
            source: { narrationText }, bypassCache, generateFn,
          })
        : await generateFn();
    } catch (error) {
      if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid sequence data', { status: 502, cause: error }));
      return fallback;
    }
  }

  async function planShotsForChunk({ chunkText, sequenceContext, style, additional, provider, fallbackPolicy, tenantId, bypassCache }) {
    if (provider === 'stub') return { shots: fallbackShotsForChunk(chunkText), usedFallback: true, warning: '' };

    const generateFn = async () => {
      const request = buildShotPlanningRequest({ chunkText, sequenceContext, style, additional });
      const parsed = extractJson(providerOutput(await textProviders.call(provider, request)));
      const shots = Array.isArray(parsed?.shots) ? parsed.shots : null;
      if (!shots?.length) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid shot data', { status: 502 });
      return shots.map((item) => ({
        narrationText: cleanNarrationText(item?.narrationText),
        visualPrompt: cleanText(item?.visualPrompt, 20_000),
        actionPrompt: compactAction(item?.actionPrompt),
      })).filter((shot) => shot.narrationText);
    };

    try {
      const shots = generationCache
        ? await generationCache.runCached({
            tenantId, operation: 'shot.plan', provider, promptTemplateVersion: 1,
            source: { chunkText, sequenceContext }, settings: { style: style?.id, additional }, bypassCache, generateFn,
          })
        : await generateFn();
      if (!shots.length) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned no usable shots', { status: 502 });
      return { shots, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid shot data', { status: 502, cause: error }));
      return { shots: fallbackShotsForChunk(chunkText), usedFallback: true, warning: `Shot planning: provider unavailable for one excerpt, local fallback shots were used. ${cleanText(error.message, 200)}` };
    }
  }

  // The one entry point: raw script in, a final, locked shot list out. Narration is generated and
  // treated as immutable before any shot boundary is decided -- shot count is never guessed, it
  // falls out of how many shots the planning calls actually returned for the finished narration.
  async function plan({ scriptText, provider, styleId, style, commonPromptText, enrich = true, fallbackPolicy = 'local', tenantId, bypassCache = false }) {
    const narration = await narrateScript({ scriptText, provider, enrich, fallbackPolicy, tenantId, bypassCache });
    if (!narration.narrationText) return { scenes: [], narrationText: '', usedFallback: false, warning: '' };

    const sequences = await scanSequences({ narrationText: narration.narrationText, provider, fallbackPolicy, tenantId, bypassCache });
    const sequenceContext = sequences.map((item) => [item.label, item.intent].filter(Boolean).join(': ')).filter(Boolean).join('; ');
    const additional = style ? getAdditionalCommonPrompt(style.promptText, commonPromptText) : commonPromptText;

    const chunks = chunkByWords(narration.narrationText, MAX_WORDS_PER_SHOT_CHUNK);
    let usedFallback = narration.usedFallback;
    const warnings = narration.warning ? [narration.warning] : [];
    const scenes = [];

    for (const chunkText of chunks) {
      const result = await planShotsForChunk({ chunkText, sequenceContext, style, additional, provider, fallbackPolicy, tenantId, bypassCache });
      if (result.usedFallback) usedFallback = true;
      if (result.warning) warnings.push(result.warning);
      for (const shot of result.shots) {
        scenes.push({
          sceneNumber: scenes.length + 1,
          title: `Scene ${scenes.length + 1}`,
          scriptFragment: shot.narrationText,
          narrationText: shot.narrationText,
          narrationIsFallback: result.usedFallback,
          beat: shot.actionPrompt,
          prompt: shot.visualPrompt,
          promptGeneratedFromBeat: shot.actionPrompt,
          promptGeneratedFromNarration: shot.narrationText,
          promptIsFallback: result.usedFallback,
        });
      }
    }

    return { scenes, narrationText: narration.narrationText, usedFallback, warning: warnings.join(' ') };
  }

  return { plan };
}

module.exports = { createShotPlanningService, chunkByWords };
