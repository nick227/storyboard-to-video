const { z } = require('zod');
const { AppError } = require('../errors');
const { cleanText, extractJson, compactAction } = require('../shared/text');
const { splitSceneIntoScenes } = require('../shared/segmentation');
const { providerOutput } = require('../providers/result');

// Bump whenever buildSplitRequest's shape or rules change meaningfully.
const SPLIT_TEMPLATE_VERSION = 1;

const splitResponseSchema = z.object({
  scenes: z.array(z.object({
    scriptFragment: z.string().trim().min(1),
    narrationText: z.string().default(''),
    beat: z.string().default(''),
  })).min(1),
});

// The one rule this whole feature depends on: prove the model only cut the source, never rewrote
// it. Deliberately dumb — collapses whitespace differences introduced by JSON transport (line
// endings, incidental trimming at the seam where the model split two children apart) and nothing
// else. No case-folding, no punctuation stripping, no tokenizing. A single inserted space between
// children absorbs the seam-trimming case (very common LLM behavior) without hiding an actual
// wording change, since any real content difference still fails the comparison.
function normalizeForExactMatch(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function childrenReconstructSource(children, sourceValue) {
  return normalizeForExactMatch(children.join(' ')) === normalizeForExactMatch(sourceValue);
}

function buildSplitRequest({ scriptFragment, narrationText, count }) {
  const hasNarration = Boolean(narrationText);
  return `Return strict JSON only: {"scenes":[{"scriptFragment":"...","narrationText":"...","beat":"..."}]}, with exactly ${count} objects, in story order.

Divide the source material below into ${count} coherent sequential scenes at natural story boundaries — a change of action or objective, a location/time transition, a dialogue exchange or subject shift, a reveal or emotional turn, a visually distinct beat, or a natural narration transition. Scenes may be uneven in length; let the story's natural divisions decide, do not force equal-sized pieces.

CRITICAL: "scriptFragment" and "narrationText" across the ${count} children must together reconstruct the source text below exactly, split at your chosen boundaries. Copy each piece verbatim — no paraphrasing, no punctuation or wording cleanup, no summarizing, no invented bridge/transition text, no omissions. Every word of each source appears in exactly one child, in order, unchanged.

"beat" is the one field you generate fresh: the child's physical action in 5-20 words, simple present tense, no camera or style wording.

Source script fragment — divide across the ${count} children's "scriptFragment":
${scriptFragment}

${hasNarration
    ? `Source narration — divide across the ${count} children's "narrationText", verbatim:\n${narrationText}`
    : 'No narration exists yet for this scene — leave every child\'s "narrationText" as an empty string.'}`;
}

function createSceneSplitService({ textProviders, generationCache }) {
  async function split({ scriptFragment, narrationText = '', count, provider, fallbackPolicy = 'local', tenantId, bypassCache = false }) {
    const deterministicScenes = () => splitSceneIntoScenes(scriptFragment, count, narrationText);
    const deterministicFallback = (warning) => ({ scenes: deterministicScenes(), usedFallback: true, warning });

    if (provider === 'stub') return deterministicFallback('Stub text mode selected; deterministic split was used.');

    const generateFn = async () => {
      const request = buildSplitRequest({ scriptFragment, narrationText, count });
      const parsed = splitResponseSchema.parse(extractJson(providerOutput(await textProviders.call(provider, request))));
      if (parsed.scenes.length !== count) {
        throw new AppError('INVALID_PROVIDER_RESPONSE', `Expected ${count} split scenes, got ${parsed.scenes.length}`, { status: 502, retryable: true });
      }
      if (!childrenReconstructSource(parsed.scenes.map((scene) => scene.scriptFragment), scriptFragment)) {
        throw new AppError('INVALID_PROVIDER_RESPONSE', 'Split scriptFragment did not exactly reconstruct the source — rejecting to avoid altered source text', { status: 502, retryable: true });
      }
      if (!childrenReconstructSource(parsed.scenes.map((scene) => scene.narrationText), narrationText)) {
        throw new AppError('INVALID_PROVIDER_RESPONSE', 'Split narrationText did not exactly reconstruct the source — rejecting to avoid altered narration', { status: 502, retryable: true });
      }
      return {
        scenes: parsed.scenes.map((scene, index) => {
          const beat = compactAction(scene.beat, 'Subject moves.');
          return {
            sceneNumber: index + 1,
            title: `Scene ${index + 1}`,
            scriptFragment: cleanText(scene.scriptFragment, 20_000),
            narrationText: cleanText(scene.narrationText, 6_000),
            narrationIsFallback: false,
            beat,
            prompt: `${beat} Clear subject, key pose, readable composition.`,
            promptGeneratedFromBeat: null,
            promptIsFallback: true,
          };
        }),
        usedFallback: false,
        warning: '',
      };
    };

    try {
      if (!generationCache) return await generateFn();
      return await generationCache.runCached({
        tenantId,
        operation: 'scene.split',
        provider,
        promptTemplateVersion: SPLIT_TEMPLATE_VERSION,
        source: { scriptFragment, narrationText, count },
        bypassCache,
        generateFn,
      });
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return deterministicFallback(`Provider unavailable or returned an invalid split; deterministic split was used. ${cleanText(error.message, 300)}`);
    }
  }

  return { split };
}

module.exports = { createSceneSplitService };
