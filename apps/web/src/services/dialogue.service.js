const { z } = require('zod');
const { AppError } = require('../errors');
const { cleanText, extractJson } = require('../shared/text');
const { chunk } = require('../shared/batching');
const { providerOutput } = require('../providers/result');

const DIALOGUE_BATCH_SIZE = 5;
const NARRATION_MAX_LENGTH = 6_000;

const generateResponseSchema = z.object({
  scenes: z.array(z.object({ sceneNumber: z.number(), narrationText: z.string() })),
});
const regenerateResponseSchema = z.object({ narrationText: z.string() });

const NARRATION_RULES = `NARRATION RULES:
1. Preserve original dialogue verbatim unless shortening is necessary for intelligibility or spoken duration. Do not paraphrase a line merely to make it sound more polished.
2. Remove screenplay labels and formatting.
3. Add calm narration only where action or context must be spoken.
4. Avoid repeatedly saying character names.
5. Use punctuation and paragraph spacing to create breathing room.
6. Prefer natural spoken length over aggressive summarization.
7. Preserve the intent of the script.
8. There is no rush to finish the scene; do not cut off narration mid-thought.
9. Never mention camera instructions, scene headings, or formatting syntax.
10. Return only exact text intended to be read aloud.`;

// No cross-scene continuity notes are passed to the model: each scene's own scriptFragment already
// contains the names, dialogue, and tone it needs. Earlier drafts passed a previous-scene tail and
// next-scene beat for "tone consistency," but models don't reliably respect a do-not-use boundary —
// that extra material risked leaked events and subtle rewriting toward neighboring scenes for no
// proven benefit. If a specific recurring problem (e.g. pronoun ambiguity) shows up in testing,
// reintroduce a narrowly-scoped fix for that problem specifically, not general continuity context.
const SOURCE_OF_TRUTH_RULE = "The source text below is the only authoritative source for this scene's content. The scene action is secondary interpretation guidance only — it may inform tone but must never introduce events, characters, or dialogue that aren't in the source text.";

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

// Degraded output only — a terse beat/title phrase, not prose. Never mistaken for a real adaptation.
function fallbackNarrationText(scene) {
  return cleanText(scene.beat, NARRATION_MAX_LENGTH) || cleanText(scene.title, 200) || 'Narration.';
}

function sceneBlock(scene) {
  return `Source text (the ONLY source for this scene's narration): ${scene.scriptFragment}
Scene action (interpretation guidance only, secondary to the source text above): ${scene.beat || 'none'}`;
}

function instructionBlock(instruction) {
  if (!instruction) return '';
  return `User instruction for this rewrite — follow it for tone, pacing, length, and emphasis, but it can never override the rule above: it must not introduce content, characters, or events absent from the source text. Instruction: ${cleanText(instruction, 500)}`;
}

function buildBatchRequest({ batchScenes }) {
  const scenesBlock = batchScenes
    .map(({ scene }) => `${scene.sceneNumber}. ${sceneBlock(scene)}`)
    .join('\n\n');
  return `Return strict JSON only: {"scenes":[{"sceneNumber":N,"narrationText":"..."}]}, one object per scene listed below.

${SOURCE_OF_TRUTH_RULE}

${NARRATION_RULES}

Scenes:
${scenesBlock}`;
}

function buildRegenerateRequest({ scene, sceneIndex, instruction }) {
  return `Return strict JSON only: {"narrationText":"..."}. Rewrite the spoken narration for scene ${sceneIndex + 1}.

${SOURCE_OF_TRUTH_RULE}

${NARRATION_RULES}
${instructionBlock(instruction)}

${sceneBlock(scene)}
Current narration (what you are revising): ${scene.narrationText || 'none yet'}`;
}

function createDialogueService({ textProviders }) {
  async function generate({ scenes, provider, fallbackPolicy = 'local' }) {
    const fallback = scenes.map((scene, index) => ({ sceneNumber: scene.sceneNumber || index + 1, narrationText: fallbackNarrationText(scene) }));
    if (provider === 'stub') return { scenesDialogue: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback narration was used.' };

    const eligible = scenes.map((scene, index) => ({ scene, index })).filter((item) => item.scene.scriptFragment);
    const results = new Array(scenes.length);
    fallback.forEach((item, index) => { results[index] = item; });

    let anyFallbackUsed = eligible.length !== scenes.length;
    const warnings = anyFallbackUsed ? ['Some scenes had no source fragment; local fallback narration was used for them.'] : [];

    // Batches run sequentially (not Promise.all). There's no cross-batch continuity state to carry
    // forward anymore, so this is no longer required for correctness — kept for now to avoid
    // parallel-request load until real timing data shows it's worth revisiting.
    const batches = chunk(eligible, DIALOGUE_BATCH_SIZE);
    for (const batch of batches) {
      const request = buildBatchRequest({ batchScenes: batch });
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
      } catch (error) {
        if (fallbackPolicy !== 'local') throw (error instanceof AppError ? error : new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid narration data', { status: 502, cause: error }));
        anyFallbackUsed = true;
        warnings.push(`Scenes ${batch[0].scene.sceneNumber}-${batch[batch.length - 1].scene.sceneNumber}: provider unavailable, local fallback used. ${cleanText(error.message, 200)}`);
      }
    }

    return { scenesDialogue: results, usedFallback: anyFallbackUsed, warning: warnings.join(' ') };
  }

  async function regenerate({ scene, sceneIndex, instruction = '', provider, fallbackPolicy = 'local' }) {
    const fallback = fallbackNarrationText(scene);
    if (provider === 'stub') return { narrationText: fallback, usedFallback: true, warning: 'Stub text mode selected; fallback narration was retained.' };
    if (!scene.scriptFragment) return { narrationText: fallback, usedFallback: true, warning: 'Scene has no source fragment to regenerate narration from; fallback narration was retained.' };

    const request = buildRegenerateRequest({ scene, sceneIndex, instruction });
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
