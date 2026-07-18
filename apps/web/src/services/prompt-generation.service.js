const { AppError } = require('../errors');
const { cleanText, extractJson, getAdditionalCommonPrompt, compactAction } = require('../shared/text');
const { chunk } = require('../shared/batching');
const { providerOutput } = require('../providers/result');

const PROMPT_BATCH_SIZE = 5;
const FRAGMENT_MAX_LENGTH = 20_000;

const PROMPT_TEMPLATE_VERSION = 2;
const ACTION_TEMPLATE_VERSION = 2;

const BEAT_RULES = `BEAT RULES:
- Describe one physical action in 5-20 words (max 24).
- Use simple present tense: subject + verb + object/direction.
- Avoid camera instructions, style, or backstory.`;

const CONTINUITY_RULE = 'Keep recurring named characters and objects consistent across adjacent scenes.';

function buildSceneSourceContext(fragment, enrich) {
  const hasNarration = enrich && fragment.narrationText && !fragment.narrationIsFallback;
  if (hasNarration) {
    return `Narration: ${cleanText(fragment.narrationText, 6_000)}\nScript fragment: ${fragment.scriptFragment}`;
  }
  return fragment.scriptFragment;
}

function buildBatchRequest({ batchFragments, batchStartIndex, sceneCount, style, additional, enrich }) {
  const scenesBlock = batchFragments
    .map((fragment, i) => `${batchStartIndex + i + 1}. ${buildSceneSourceContext(fragment, enrich)}`)
    .join('\n\n');

  return `Return JSON: {"scenes":[{"sceneNumber":N,"title":"...","beat":"...","prompt":"..."}]}.
Create scenes ${batchStartIndex + 1}-${batchStartIndex + batchFragments.length} of ${sceneCount}.

${BEAT_RULES}

PROMPT RULES:
- Describe the keyframe at the action's clearest physical moment in 15-40 words.
- State subject, pose, important object, location, and composition.
- No motion sequence, camera movement, or style wording.

Style context: ${style.promptText}.
Additional: ${additional || 'none'}.

Scene sources:
${scenesBlock}`;
}

function createPromptGenerationService({ textProviders, limits, generationCache }) {
  async function generate({ scenes: inputScenes, style, commonPromptText, provider, fallbackPolicy = 'local', enrich = true }) {
    if (!Array.isArray(inputScenes) || inputScenes.length === 0) {
      return { scenes: [], usedFallback: false, warning: '' };
    }

    const fallback = inputScenes.map((scene, index) => {
      const beat = compactAction(scene.scriptFragment);
      return {
        sceneNumber: scene.sceneNumber || index + 1,
        title: scene.title || `Scene ${index + 1}`,
        scriptFragment: scene.scriptFragment,
        beat,
        prompt: `${beat} Clear subject, key pose, readable composition.`,
        promptGeneratedFromBeat: null,
        promptIsFallback: true,
      };
    });

    if (provider === 'stub') {
      return { scenes: fallback, usedFallback: true, warning: 'Stub text mode selected; local fallback prompts were used.' };
    }

    const additional = getAdditionalCommonPrompt(style.promptText, commonPromptText);
    const batches = chunk(inputScenes, PROMPT_BATCH_SIZE);
    const scenes = new Array(inputScenes.length);
    let anyFallbackUsed = false;
    const warnings = [];

    for (let b = 0; b < batches.length; b += 1) {
      const batchFragments = batches[b];
      const batchStartIndex = b * PROMPT_BATCH_SIZE;
      const request = buildBatchRequest({ batchFragments, batchStartIndex, sceneCount: inputScenes.length, style, additional, enrich });
      try {
        const parsed = extractJson(providerOutput(await textProviders.call(provider, request)));
        if (!Array.isArray(parsed?.scenes)) {
          throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid scene data', { status: 502, retryable: true });
        }
        
        const bySceneNumber = new Map(parsed.scenes.map((item) => [item.sceneNumber, item]));
        
        batchFragments.forEach((fragment, i) => {
          const base = fallback[batchStartIndex + i];
          const item = bySceneNumber.get(fragment.sceneNumber);
          const beat = compactAction(item?.beat, base.beat);
          const usedNarrationSource = enrich && Boolean(fragment.narrationText) && !fragment.narrationIsFallback;
          
          scenes[batchStartIndex + i] = {
            ...base,
            title: cleanText(item?.title, 200) || base.title,
            beat,
            prompt: cleanText(item?.prompt, limits.prompt) || base.prompt,
            promptGeneratedFromBeat: beat,
            promptGeneratedFromNarration: usedNarrationSource ? fragment.narrationText : null,
            promptIsFallback: false,
          };
        });

        if (parsed.scenes.length !== batchFragments.length) {
          anyFallbackUsed = true;
        }
      } catch (error) {
        if (fallbackPolicy !== 'local') throw error;
        batchFragments.forEach((_fragment, i) => {
          scenes[batchStartIndex + i] = fallback[batchStartIndex + i];
        });
        anyFallbackUsed = true;
        warnings.push(`Scenes ${batchStartIndex + 1}-${batchStartIndex + batchFragments.length}: provider unavailable, local fallback used. ${cleanText(error.message, 200)}`);
      }
    }

    return { scenes, usedFallback: anyFallbackUsed, warning: warnings.join(' ') || (anyFallbackUsed ? 'Local fallback filled some scenes.' : '') };
  }

  async function regeneratePrompt({ scene, sceneIndex, style, commonPromptText, provider, extraPromptText, fallbackPolicy = 'local', enrich = true, tenantId, bypassCache = false }) {
    const fallbackPrompt = `${scene.prompt || ''} ${extraPromptText || ''}`.trim();
    const fallback = {
      prompt: fallbackPrompt,
      usedFallback: true,
      warning: '',
      promptGeneratedFromBeat: null,
      promptGeneratedFromNarration: null,
    };

    if (provider === 'stub') {
      return { ...fallback, warning: 'Stub text mode selected; the existing prompt was retained.' };
    }

    const source = cleanText(scene?.scriptFragment, FRAGMENT_MAX_LENGTH);
    if (!source) throw new AppError('SCENE_FRAGMENT_MISSING', 'Scene has no script fragment', { status: 400 });
    
    const usedNarrationSource = enrich && Boolean(scene?.narrationText) && !scene?.narrationIsFallback;
    const sourceBlock = usedNarrationSource
      ? `Narration: ${cleanText(scene.narrationText, 6_000)}.\nScript fragment: ${source}`
      : `Scene script excerpt (use ONLY this text as source): ${source}`;

    const generateFn = async () => {
      const request = `Return strict JSON only: {"prompt":"..."}. Rewrite the Visual Prompt. Show this physical action: ${scene.beat || ''}. State subject, pose, important object, location, and composition. No style wording. ${CONTINUITY_RULE} ${sourceBlock}. Existing Visual Prompt: ${scene.prompt || ''}. Note: ${extraPromptText || 'none'}. Selected style context: ${style.promptText}. Additional: ${getAdditionalCommonPrompt(style.promptText, commonPromptText) || 'none'}.`;
      const value = cleanText(extractJson(providerOutput(await textProviders.call(provider, request)))?.prompt, limits.prompt);
      if (!value) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid prompt data', { status: 502 });
      return {
        prompt: value,
        usedFallback: false,
        warning: '',
        promptGeneratedFromBeat: scene.beat || '',
        promptGeneratedFromNarration: usedNarrationSource ? scene.narrationText : null,
      };
    };

    try {
      if (!generationCache) return await generateFn();
      return await generationCache.runCached({
        tenantId,
        operation: 'prompt.regenerate',
        provider,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        source: {
          source,
          sceneIndex,
          title: scene.title || '',
          beat: scene.beat || '',
          existingPrompt: scene.prompt || '',
          usedNarrationSource,
          narrationText: usedNarrationSource ? scene.narrationText : '',
          extraPromptText,
          styleId: style.id,
          stylePromptText: style.promptText || '',
          commonPromptText,
        },
        settings: { enrich },
        bypassCache,
        generateFn
      });
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { ...fallback, warning: `Provider unavailable; the existing prompt was retained. ${cleanText(error.message, 300)}` };
    }
  }

  async function regenerateAction({ scene, sceneIndex, provider, fallbackPolicy = 'local', tenantId, bypassCache = false }) {
    const source = cleanText(scene?.scriptFragment, FRAGMENT_MAX_LENGTH);
    const fallbackBeat = compactAction(source, scene?.beat || 'Subject moves.');
    const fallback = {
      beat: fallbackBeat,
      usedFallback: true,
      warning: '',
    };

    if (provider === 'stub') {
      return { ...fallback, warning: 'Stub text mode selected; local fallback action was used.' };
    }
    if (!source) throw new AppError('SCENE_FRAGMENT_MISSING', 'Scene has no script fragment', { status: 400 });

    const generateFn = async () => {
      const request = `Return strict JSON only: {"beat":"..."}. Rewrite the physical action (Beat) for scene ${sceneIndex + 1} in 5-24 words.
${BEAT_RULES}
This scene's exact script excerpt: ${source}
Existing action: ${scene?.beat || 'none'}.`;
      const value = compactAction(extractJson(providerOutput(await textProviders.call(provider, request)))?.beat, '');
      if (!value) throw new AppError('INVALID_PROVIDER_RESPONSE', 'The text provider returned invalid action data', { status: 502 });
      return { beat: value, usedFallback: false, warning: '' };
    };

    try {
      if (!generationCache) return await generateFn();
      return await generationCache.runCached({
        tenantId,
        operation: 'action.regenerate',
        provider,
        promptTemplateVersion: ACTION_TEMPLATE_VERSION,
        source: { source, sceneIndex, existingBeat: scene?.beat || '' },
        bypassCache,
        generateFn
      });
    } catch (error) {
      if (fallbackPolicy !== 'local') throw error;
      return { ...fallback, warning: `Provider unavailable; the existing action was retained. ${cleanText(error.message, 300)}` };
    }
  }

  return { compactAction, generate, regeneratePrompt, regenerateAction };
}

module.exports = { createPromptGenerationService };
