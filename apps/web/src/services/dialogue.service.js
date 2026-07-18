const { z } = require('zod');
const { AppError } = require('../errors');
const { cleanText, extractJson } = require('../shared/text');
const { chunk } = require('../shared/batching');
const { providerOutput } = require('../providers/result');

const DIALOGUE_BATCH_SIZE = 5;
const NARRATION_MAX_LENGTH = 6_000;

// Bump whenever narrationRules()/sourceOfTruthRule()/buildRegenerateRequest's shape changes
// meaningfully — this invalidates old exact-input cache entries so a prompt-quality improvement
// can't keep silently serving pre-improvement narration forever.
const NARRATION_TEMPLATE_VERSION = 2;

const generateResponseSchema = z.object({
  scenes: z.array(z.object({ sceneNumber: z.number(), narrationText: z.string() })),
});
const regenerateResponseSchema = z.object({ narrationText: z.string() });

const ATTRIBUTION_RULE = 'One narrator voice reads every line, so most dialogue can stand alone without a trailing "[Name] said" tag — use an explicit tag only where the speaker would otherwise be ambiguous.';

const NARRATION_CORE = `NARRATION RULES:
1. Cover everything in the source that matters to the story, in order — a longer fragment should produce a proportionally longer passage. Do not rush, thin out, or cut off mid-thought.
2. Preserve original dialogue verbatim; never paraphrase, shorten, or drop a line.
3. Strip screenplay labels and formatting. Never mention camera instructions or scene headings.
4. ${ATTRIBUTION_RULE}
5. Use punctuation and paragraph spacing for breathing room, and preserve the script's intent.
6. Return only text intended to be read aloud.`;

const NARRATION_DELTA_ENRICHED = "This is a full narrated adaptation: also narrate setting, atmosphere, and physical action, with extra care at a location or dynamic shift a viewer would see but a listener can't — cinematically paint the picture there, as long as you invent no new plot, characters, or dialogue.";
const NARRATION_DELTA_LITERAL = 'This is a light narrated read-through: stay close to the source, narrating action only to the minimum needed to keep the scene intelligible as audio — no invented scenery or atmosphere.';

function narrationRules(enrich) {
  return `${NARRATION_CORE}\n7. ${enrich ? NARRATION_DELTA_ENRICHED : NARRATION_DELTA_LITERAL}`;
}

// No cross-scene continuity notes are passed to the model: each scene's own scriptFragment already
// contains the names, dialogue, and tone it needs. Earlier drafts passed a previous-scene tail and
// next-scene beat for "tone consistency," but models don't reliably respect a do-not-use boundary —
// that extra material risked leaked events and subtle rewriting toward neighboring scenes for no
// proven benefit. If a specific recurring problem (e.g. pronoun ambiguity) shows up in testing,
// reintroduce a narrowly-scoped fix for that problem specifically, not general continuity context.
function sourceOfTruthRule(enrich) {
  const elaboration = enrich
    ? 'Sensory or atmospheric detail may be added to bring an implied setting, transition, or dynamic to life'
    : 'Do not add sensory or atmospheric detail beyond what the source states';
  return `The source text is the only authoritative source for this scene's content; the scene action is secondary interpretation guidance only. ${elaboration}, but never a new plot event, character, or line of dialogue that isn't in the source.`;
}

function truncateAtBoundary(value, maxLength) {
  const trimmed = String(value || '').trim();
  if (trimmed.length <= maxLength) return trimmed;
  const slice = trimmed.slice(0, maxLength);
  const paragraphBreak = slice.lastIndexOf('\n\n');
  const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
  // Prefer cutting at a paragraph or sentence boundary over an arbitrary character offset, so a
  // length cap can never sever a line of dialogue mid-sentence. Only fall back to a hard cutoff if
  // no boundary exists in at least the back half of the allowed length.
  const boundary = paragraphBreak > maxLength * 0.5 ? paragraphBreak : (sentenceEnd > maxLength * 0.5 ? sentenceEnd + 1 : -1);
  return (boundary > -1 ? slice.slice(0, boundary) : slice).trim();
}

function cleanNarrationText(value) {
  return truncateAtBoundary(value, NARRATION_MAX_LENGTH);
}

// Degraded output only — a terse beat/title phrase, not prose. Callers must gate on this result's
// usedFallback flag (never re-derive it from the text) before treating narrationText as real,
// tellable narration — e.g. before sending it to audio generation.
function fallbackNarrationText(scene) {
  return cleanText(scene.beat, NARRATION_MAX_LENGTH) || cleanText(scene.title, 200) || 'Narration.';
}

function sceneBlock(scene) {
  return `Source text (the ONLY source for this scene's narration): ${scene.scriptFragment}
Scene action (interpretation guidance only, secondary to the source text above): ${scene.beat || 'none'}`;
}

function instructionBlock(instruction) {
  if (!instruction) return '';
  return `User instruction (tone, pacing, length, emphasis) — it cannot add events, characters, or dialogue outside the source: ${cleanText(instruction, 500)}`;
}

function buildBatchRequest({ batchScenes, enrich }) {
  const scenesBlock = batchScenes
    .map(({ scene }) => `${scene.sceneNumber}. ${sceneBlock(scene)}`)
    .join('\n\n');
  return `Return strict JSON only: {"scenes":[{"sceneNumber":N,"narrationText":"..."}]}, one object per scene listed below. Give each scene depth proportional to its own source length, regardless of its position in this batch.

${sourceOfTruthRule(enrich)}

${narrationRules(enrich)}

Scenes:
${scenesBlock}`;
}

function buildRegenerateRequest({ scene, sceneIndex, instruction, enrich }) {
  return `Return strict JSON only: {"narrationText":"..."}. Rewrite the spoken narration for scene ${sceneIndex + 1}.

${sourceOfTruthRule(enrich)}

${narrationRules(enrich)}
${instructionBlock(instruction)}

${sceneBlock(scene)}
Current narration (what you are revising): ${scene.narrationText || 'none yet'}`;
}

function createDialogueService({ textProviders, generationCache }) {
  function fallbackResult(scene, index) {
    return { sceneNumber: scene.sceneNumber || index + 1, narrationText: fallbackNarrationText(scene), usedFallback: true };
  }

  async function generate({ scenes, provider, fallbackPolicy = 'local', enrich = true }) {
    // Every scene carries its OWN usedFallback — the top-level usedFallback/warning below remain an
    // aggregate summary (any scene fell back), but callers that gate behavior per scene (e.g. audio
    // generation refusing fallback narration) must read scenesDialogue[i].usedFallback, never the
    // aggregate, or one bad scene in a batch marks every scene in the response as fallback.
    if (provider === 'stub') {
      return { scenesDialogue: scenes.map(fallbackResult), usedFallback: true, warning: 'Stub text mode selected; local fallback narration was used.' };
    }

    const eligible = scenes.map((scene, index) => ({ scene, index })).filter((item) => item.scene.scriptFragment);
    const results = new Array(scenes.length);
    scenes.forEach((scene, index) => {
      if (!scene.scriptFragment) results[index] = fallbackResult(scene, index);
    });

    let anyFallbackUsed = eligible.length !== scenes.length;
    const warnings = anyFallbackUsed ? ['Some scenes had no source fragment; local fallback narration was used for them.'] : [];

    // Batches run sequentially (not Promise.all). There's no cross-batch continuity state to carry
    // forward anymore, so this is no longer required for correctness — kept for now to avoid
    // parallel-request load until real timing data shows it's worth revisiting.
    const batches = chunk(eligible, DIALOGUE_BATCH_SIZE);
    for (const batch of batches) {
      const request = buildBatchRequest({ batchScenes: batch, enrich });
      try {
        const parsed = generateResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
        const bySceneNumber = new Map(parsed.scenes.map((item) => [item.sceneNumber, item]));
        for (const { scene, index } of batch) {
          const sceneNumber = scene.sceneNumber || index + 1;
          const item = bySceneNumber.get(sceneNumber);
          const narrationText = item ? cleanNarrationText(item.narrationText) : '';
          if (narrationText) {
            results[index] = { sceneNumber, narrationText, usedFallback: false };
          } else {
            anyFallbackUsed = true;
            results[index] = fallbackResult(scene, index);
            warnings.push(item
              ? `Scene ${sceneNumber}: provider returned empty narration, local fallback narration was used.`
              : `Scene ${sceneNumber}: provider omitted this scene, local fallback narration was used.`);
          }
        }
      } catch (error) {
        if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid narration data', { status: 502, cause: error }));
        anyFallbackUsed = true;
        batch.forEach(({ scene, index }) => { results[index] = fallbackResult(scene, index); });
        warnings.push(`Scenes ${batch[0].scene.sceneNumber}-${batch[batch.length - 1].scene.sceneNumber}: provider unavailable, local fallback used. ${cleanText(error.message, 200)}`);
      }
    }

    return { scenesDialogue: results, usedFallback: anyFallbackUsed, warning: warnings.join(' ') };
  }

  async function regenerateNarration({ scene, sceneIndex, instruction = '', provider, fallbackPolicy = 'local', enrich = true, tenantId, bypassCache = false }) {
    const fallback = fallbackNarrationText(scene);
    if (provider === 'stub') return { narrationText: fallback, usedFallback: true, warning: 'Stub text mode selected; fallback narration was retained.' };
    if (!scene.scriptFragment) return { narrationText: fallback, usedFallback: true, warning: 'Scene has no source fragment to regenerate narration from; fallback narration was retained.' };

    // Exact-input reuse: only for a real single-scene regenerate, never the bulk batch generate()
    // above (a batch's fingerprint would need every scene in it to match verbatim, which defeats the
    // purpose). Skipped entirely when the caller has no tenantId (e.g. internal callers/tests that
    // don't wire a cache) or explicitly requests a new variation via bypassCache. The fingerprint
    // covers every request-affecting field, including the current narration being revised — omitting
    // it would let two different "current narration" inputs collide on the same cache entry.
    const fingerprintInput = tenantId ? {
      tenantId, operation: 'narration.regenerate', provider, promptTemplateVersion: NARRATION_TEMPLATE_VERSION,
      source: JSON.stringify({ scriptFragment: scene.scriptFragment, beat: scene.beat || '', narrationText: scene.narrationText || '', instruction }),
      settings: { enrich },
    } : null;

    if (fingerprintInput && generationCache && !bypassCache) {
      const cached = await generationCache.lookup(fingerprintInput);
      if (cached) return { ...cached.result, cacheHit: true };
    }

    const request = buildRegenerateRequest({ scene, sceneIndex, instruction, enrich });
    try {
      const parsed = regenerateResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
      const narrationText = cleanNarrationText(parsed.narrationText);
      if (!narrationText) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned empty narration data', { status: 502 });
      const result = { narrationText, usedFallback: false, warning: '' };
      // Only a real (non-fallback) result is ever cached — a fallback response must never be served
      // back later as if it were successful provider output.
      if (fingerprintInput && generationCache) await generationCache.record(fingerprintInput, result, { bypassed: bypassCache });
      return result;
    } catch (error) {
      if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid narration data', { status: 502, cause: error }));
      return { narrationText: fallback, usedFallback: true, warning: `Provider unavailable; fallback narration was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { cleanNarrationText, generate, regenerateNarration };
}

module.exports = { cleanNarrationText, createDialogueService, fallbackNarrationText };
