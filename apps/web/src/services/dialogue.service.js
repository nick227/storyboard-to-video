const { z } = require('zod');
const { AppError } = require('../errors');
const { cleanText, extractJson } = require('../shared/text');
const { chunk } = require('../shared/batching');
const { providerOutput } = require('../providers/result');

const DIALOGUE_BATCH_SIZE = 5;
const NARRATION_MAX_LENGTH = 6_000;
const TAIL_LENGTH = 200;

const generateResponseSchema = z.object({
  scenes: z.array(z.object({ sceneNumber: z.number(), narrationText: z.string() })),
});
const regenerateResponseSchema = z.object({ narrationText: z.string() });

const NARRATION_RULES = `NARRATION RULES:
1. Preserve substantial original dialogue.
2. Remove screenplay labels and formatting.
3. Add calm narration only where action or context must be spoken.
4. Avoid repeatedly saying character names.
5. Use punctuation and paragraph spacing to create breathing room.
6. Prefer natural spoken length over aggressive summarization.
7. Never mention camera instructions, scene headings, or formatting syntax.
8. Return only text intended to be read aloud.`;

const SOURCE_OF_TRUTH_RULE = "Each scene's source text below is the only authoritative source for that scene's content. Continuity notes (previous scene's ending, next scene's action) are for tone and name consistency only — never introduce events, dialogue, or details from them into the current scene's output.";

function cleanNarrationText(value) {
  return cleanText(value, NARRATION_MAX_LENGTH);
}

// Degraded output only — a terse beat/title phrase, not prose. Never mistaken for a real adaptation.
function fallbackNarrationText(scene) {
  return cleanText(scene.beat, NARRATION_MAX_LENGTH) || cleanText(scene.title, 200) || 'Narration.';
}

function tailOf(text) {
  return cleanText(text, TAIL_LENGTH * 4).slice(-TAIL_LENGTH);
}

function buildBatchRequest({ batchScenes, previousTail }) {
  const continuityBlock = previousTail
    ? `Continuity reference only — do not copy, quote, or reuse this wording in the current scene's output; it exists so tone and names stay consistent, not as source material. Previous scene ended: "${previousTail}"`
    : 'This is the first batch of scenes; there is no prior continuity yet.';
  const scenesBlock = batchScenes
    .map(({ scene, nextBeat }) => `${scene.sceneNumber}. Scene action: ${scene.beat || 'none'}. Next scene's action (forward continuity only, do not narrate it here): ${nextBeat || 'none'}. Source text (the ONLY source for this scene's narration): ${scene.scriptFragment}`)
    .join('\n\n');
  return `Return strict JSON only: {"scenes":[{"sceneNumber":N,"narrationText":"..."}]}, one object per scene listed below.

${SOURCE_OF_TRUTH_RULE}

${continuityBlock}

${NARRATION_RULES}

Scenes:
${scenesBlock}`;
}

function buildRegenerateRequest({ scene, sceneIndex, previousText, nextBeat, instruction }) {
  const continuityBlock = previousText
    ? `Continuity reference only — do not copy, quote, or reuse this wording; it exists so tone and names stay consistent, not as source material. Previous scene ended: "${tailOf(previousText)}"`
    : 'This is the first scene; there is no prior continuity.';
  const instructionBlock = instruction ? `User instruction for this rewrite — follow it explicitly: ${cleanText(instruction, 500)}` : '';
  return `Return strict JSON only: {"narrationText":"..."}. Rewrite the spoken narration for scene ${sceneIndex + 1}.

${SOURCE_OF_TRUTH_RULE}

${continuityBlock}
Next scene's action (forward continuity only, do not narrate it here): ${nextBeat || 'none'}

${NARRATION_RULES}
${instructionBlock}

Scene action: ${scene.beat || 'none'}
Source text (the ONLY source for this scene's narration): ${scene.scriptFragment}
Current narration (what you are revising): ${scene.narrationText || 'none yet'}`;
}

function createDialogueService({ textProviders }) {
  async function generate({ scenes, provider, fallbackPolicy = 'local' }) {
    const fallback = scenes.map((scene, index) => ({ sceneNumber: scene.sceneNumber || index + 1, narrationText: fallbackNarrationText(scene) }));
    if (provider === 'stub') return { scenesDialogue: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback narration was used.' };

    const eligible = scenes.map((scene, index) => ({ scene, index, nextBeat: scenes[index + 1]?.beat || '' })).filter((item) => item.scene.scriptFragment);
    const results = new Array(scenes.length);
    fallback.forEach((item, index) => { results[index] = item; });

    let anyFallbackUsed = eligible.length !== scenes.length;
    const warnings = anyFallbackUsed ? ['Some scenes had no source fragment; local fallback narration was used for them.'] : [];
    let previousTail = '';

    // Batches run sequentially (not Promise.all) so continuity reflects the real previous scene's
    // output, not a guess made in parallel — same reasoning as prompt-generation.service.js.
    const batches = chunk(eligible, DIALOGUE_BATCH_SIZE);
    for (const batch of batches) {
      const request = buildBatchRequest({ batchScenes: batch, previousTail });
      try {
        const parsed = generateResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
        const bySceneNumber = new Map(parsed.scenes.map((item) => [item.sceneNumber, item]));
        for (const { scene, index } of batch) {
          const sceneNumber = scene.sceneNumber || index + 1;
          const item = bySceneNumber.get(sceneNumber);
          if (item) {
            results[index] = { sceneNumber, narrationText: cleanNarrationText(item.narrationText) };
          } else {
            anyFallbackUsed = true;
            warnings.push(`Scene ${sceneNumber}: provider omitted this scene, local fallback narration was used.`);
          }
        }
        const last = batch[batch.length - 1];
        previousTail = tailOf(results[last.index].narrationText);
      } catch (error) {
        if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid narration data', { status: 502, cause: error }));
        anyFallbackUsed = true;
        warnings.push(`Scenes ${batch[0].scene.sceneNumber}-${batch[batch.length - 1].scene.sceneNumber}: provider unavailable, local fallback used. ${cleanText(error.message, 200)}`);
        const last = batch[batch.length - 1];
        previousTail = tailOf(results[last.index].narrationText);
      }
    }

    return { scenesDialogue: results, usedFallback: anyFallbackUsed, warning: warnings.join(' ') };
  }

  async function regenerate({ scene, sceneIndex, previousText = '', nextBeat = '', instruction = '', provider, fallbackPolicy = 'local' }) {
    const fallback = fallbackNarrationText(scene);
    if (provider === 'stub') return { narrationText: fallback, usedFallback: true, warning: 'Stub text mode selected; fallback narration was retained.' };
    if (!scene.scriptFragment) return { narrationText: fallback, usedFallback: true, warning: 'Scene has no source fragment to regenerate narration from; fallback narration was retained.' };

    const request = buildRegenerateRequest({ scene, sceneIndex, previousText, nextBeat, instruction });
    try {
      const parsed = regenerateResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
      const narrationText = cleanNarrationText(parsed.narrationText);
      if (!narrationText) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned empty narration data', { status: 502 });
      return { narrationText, usedFallback: false, warning: '' };
    } catch (error) {
      if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid narration data', { status: 502, cause: error }));
      return { narrationText: fallback, usedFallback: true, warning: `Provider unavailable; fallback narration was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { cleanNarrationText, generate, regenerate };
}

module.exports = { cleanNarrationText, createDialogueService, fallbackNarrationText };
