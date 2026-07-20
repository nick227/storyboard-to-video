const { z } = require('zod');
const { AppError } = require('../errors');
const { cleanText, extractJson } = require('../shared/text');
const { chunk } = require('../shared/batching');
const { providerOutput } = require('../providers/result');

const DIALOGUE_BATCH_SIZE = 5;
const NARRATION_MAX_LENGTH = 6_000;

// Bump whenever NARRATION_RULES_ENRICHED/NARRATION_RULES_LITERAL or buildRegenerateRequest's shape
// changes meaningfully — this invalidates old exact-input cache entries so a prompt-quality
// improvement can't keep silently serving pre-improvement narration forever.
const NARRATION_TEMPLATE_VERSION = 1;

const generateResponseSchema = z.object({
  scenes: z.array(z.object({ sceneNumber: z.number(), narrationText: z.string() })),
});
const regenerateResponseSchema = z.object({ narrationText: z.string() });

const ATTRIBUTION_RULE = 'Avoid repetitive "[Name] said" attribution tags; let dialogue stand on its own without unnecessary speaker labels.';

// Enrich on: full cinematic adaptation — the model is explicitly licensed to expand beyond a literal
// transcription (setting, atmosphere, transitions) as long as it doesn't invent plot content.
const NARRATION_RULES_ENRICHED = `NARRATION RULES:
1. This is a full narrated adaptation of the source text, not a summary. Cover everything in it that matters to the story — every event, every setting and atmosphere detail, and every line of dialogue — in the order it happens. A long fragment should produce a proportionally long passage; do not compress or skip material just to finish quickly.
2. Attempt to preserve original dialogue intent. We may drop lines to save space but catch important or key dialogue.
3. Remove screenplay labels and formatting.
4. Narrate the setting, atmosphere, and physical action too, not just dialogue — the environment is part of the story and should be heard, not thinned out or dropped.
5. Give special care and room to moments where the script shifts location or sets up a new dynamic between characters — the kind of thing a reader would pick up instantly from a scene heading or visual staging that a listener can't see. This is the place to cinematically paint the picture in words: where they are now, what it feels like, what's changed. Elaborating here is encouraged, not something to be brief about.
7. Use punctuation and paragraph spacing to create breathing room.
8. Preserve the intent of the script.
9. There is no rush to finish the scene. Do not cut off narration mid-thought, and do not thin out or rush the passage just because the source is long or there are other scenes to get through.
10. Never mention camera instructions, scene headings, or formatting syntax.
11. Return only exact text intended to be read aloud.`;

// Enrich off: a light narrated read-through for users who want narration and imagery to track the
// original script closely — no invented scenery, atmosphere, or elaboration beyond what it takes to
// keep the scene intelligible as audio.
const NARRATION_RULES_LITERAL = `NARRATION RULES:
1. Stay close to the source text — this is a light narrated read-through, not an embellished adaptation. Do not add scenery, atmosphere, or events beyond what the source text states.
2. Preserve original dialogue verbatim. Do not paraphrase a line to make it sound more polished, and do not shorten or drop a line to save space.
3. Remove screenplay labels and formatting.
4. Narrate action only to the minimum needed to keep the scene intelligible as audio — brief, not descriptive.
5. ${ATTRIBUTION_RULE}
6. Use punctuation and paragraph spacing to create breathing room.
7. Preserve the intent of the script.
8. There is no rush to finish the scene. Do not cut off narration mid-thought.
9. Never mention camera instructions, scene headings, or formatting syntax.
10. Return only exact text intended to be read aloud.`;

function narrationRules(enrich) {
  return enrich ? NARRATION_RULES_ENRICHED : NARRATION_RULES_LITERAL;
}

function sourceOfTruthRule(enrich) {
  const detailRule = enrich ? 'Narration may add sensory/atmospheric details.' : 'Do not add details beyond the source.';
  return `The source text below is the only authority. ${detailRule} Do not introduce new plot events, characters, or dialogue.`;
}

function cleanNarrationText(value) {
  return cleanText(value, NARRATION_MAX_LENGTH);
}

// Explicit fallback placeholder, not mistaken for valid generated prose.
function fallbackNarrationText(scene) {
  return `[Fallback Narration: ${cleanText(scene.beat, 100) || 'scene audio placeholder'}]`;
}

function sceneBlock(scene) {
  return `Source text (the ONLY source for this scene's narration): ${scene.scriptFragment}
Scene action (interpretation guidance only, secondary to the source text above): ${scene.beat || 'none'}`;
}

function instructionBlock(instruction) {
  if (!instruction) return '';
  return `User instruction for this rewrite — follow it for tone, pacing, length, and emphasis, but it can never override the rule above: it must not introduce content, characters, or events absent from the source text. Instruction: ${cleanText(instruction, 500)}`;
}

// LLMs given several items in one request tend to give the earliest ones the most attention and
// compress the later ones to wrap up the response — an explicit reminder here counteracts that,
// since each scene below must stand on its own regardless of its position in the batch.
const BATCH_DEPTH_RULE = "Give every scene below equal depth and completeness relative to the length of its own source text — do not write progressively shorter or thinner passages for later scenes simply because there are multiple scenes in this request.";

function buildBatchRequest({ batchScenes, enrich }) {
  const scenesBlock = batchScenes
    .map(({ scene }) => `${scene.sceneNumber}. ${sceneBlock(scene)}`)
    .join('\n\n');
  return `Return strict JSON only: {"scenes":[{"sceneNumber":N,"narrationText":"..."}]}, one object per scene listed below.

${sourceOfTruthRule(enrich)}

${narrationRules(enrich)}
${BATCH_DEPTH_RULE}

Scenes:
${scenesBlock}`;
}

function buildRegenerateRequest({ scene, instruction, enrich }) {
  return `Return strict JSON only: {"narrationText":"..."}. Rewrite the spoken narration.

${sourceOfTruthRule(enrich)}

${narrationRules(enrich)}
${instructionBlock(instruction)}

${sceneBlock(scene)}
Current narration (what you are revising): ${scene.narrationText || 'none yet'}`;
}

function createDialogueService({ textProviders, generationCache }) {
  async function generate({ scenes, provider, fallbackPolicy = 'local', enrich = true }) {
    // Every scene carries its OWN usedFallback — the top-level usedFallback/warning below remain an
    // aggregate summary (any scene fell back), but callers that gate behavior per scene (e.g. audio
    // generation refusing fallback narration) must read scenesDialogue[i].usedFallback, never the
    // aggregate, or one bad scene in a batch marks every scene in the response as fallback.
    const fallback = scenes.map((scene, index) => ({ sceneNumber: scene.sceneNumber || index + 1, narrationText: fallbackNarrationText(scene), usedFallback: true }));
    if (provider === 'stub') return { scenesDialogue: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback narration was used.' };

    const eligible = scenes.map((scene, index) => ({ scene, index })).filter((item) => item.scene.scriptFragment);
    const results = new Array(scenes.length);
    fallback.forEach((item, index) => { results[index] = item; });

    let anyFallbackUsed = eligible.length !== scenes.length;
    const warnings = anyFallbackUsed ? ['Some scenes had no source fragment; local fallback narration was used for them.'] : [];

    // Batches run sequentially (not Promise.all) for rate/load control.
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
            // Reject/replace blank output the same way regenerate() already does, instead of
            // silently storing an empty narrationText as if the scene had succeeded.
            anyFallbackUsed = true;
            results[index] = { sceneNumber, narrationText: fallbackNarrationText(scene), usedFallback: true };
            warnings.push(item
              ? `Scene ${sceneNumber}: provider returned empty narration, local fallback narration was used.`
              : `Scene ${sceneNumber}: provider omitted this scene, local fallback narration was used.`);
          }
        }
      } catch (error) {
        if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid narration data', { status: 502, cause: error }));
        anyFallbackUsed = true;
        warnings.push(`Scenes ${batch[0].scene.sceneNumber}-${batch[batch.length - 1].scene.sceneNumber}: provider unavailable, local fallback used. ${cleanText(error.message, 200)}`);
      }
    }

    return { scenesDialogue: results, usedFallback: anyFallbackUsed, warning: warnings.join(' ') };
  }

  async function regenerate({ scene, instruction = '', provider, fallbackPolicy = 'local', enrich = true, tenantId, bypassCache = false }) {
    const fallback = fallbackNarrationText(scene);
    if (provider === 'stub') return { narrationText: fallback, usedFallback: true, warning: 'Stub text mode selected; fallback narration was retained.' };
    if (!scene.scriptFragment) return { narrationText: fallback, usedFallback: true, warning: 'Scene has no source fragment to regenerate narration from; fallback narration was retained.' };

    const generateFn = async () => {
      const request = buildRegenerateRequest({ scene, instruction, enrich });
      const parsed = regenerateResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
      const narrationText = cleanNarrationText(parsed.narrationText);
      if (!narrationText) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned empty narration data', { status: 502 });
      return { narrationText, usedFallback: false, warning: '' };
    };

    try {
      if (!generationCache) return await generateFn();
      return await generationCache.runCached({
        tenantId,
        operation: 'narration.regenerate',
        provider,
        promptTemplateVersion: NARRATION_TEMPLATE_VERSION,
        source: { scriptFragment: scene.scriptFragment, beat: scene.beat || '', instruction },
        settings: { enrich },
        bypassCache,
        generateFn
      });
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { narrationText: fallback, usedFallback: true, warning: `Provider unavailable; fallback narration was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { cleanNarrationText, generate, regenerate };
}

module.exports = { cleanNarrationText, createDialogueService, fallbackNarrationText, narrationRules, sourceOfTruthRule };
