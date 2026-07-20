const { AppError } = require('../errors');
const { VIDEO_PROVIDERS } = require('./video-provider-capabilities');

const RESOLUTION_TIERS = Object.freeze(['draft', 'standard', 'high', 'ultra']);
const IMAGE_QUALITY_LEVELS = Object.freeze(['low', 'medium', 'high']);
const ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);

// These preserve the effective output choices that predate the centralized policy. A shared
// project aspect ratio replaces the modality-specific aspect ratios only when it is explicitly set.
const PLATFORM_MEDIA_DEFAULTS = Object.freeze({
  aspectRatio: null,
  image: Object.freeze({ aspectRatio: '1:1', resolutionTier: 'standard', quality: 'medium' }),
  video: Object.freeze({ aspectRatio: '4:3', resolutionTier: 'draft' }),
});

const GEMINI_DIMENSIONS = Object.freeze({
  '1:1': [1024, 1024], '2:3': [848, 1264], '3:2': [1264, 848], '3:4': [896, 1200],
  '4:3': [1200, 896], '4:5': [928, 1152], '5:4': [1152, 928], '9:16': [768, 1376],
  '16:9': [1376, 768], '21:9': [1584, 672],
});

const OPENAI_DIMENSIONS = Object.freeze({
  '1:1': Object.freeze({ width: 1024, height: 1024, providerValue: '1024x1024' }),
  '2:3': Object.freeze({ width: 1024, height: 1536, providerValue: '1024x1536' }),
  '3:2': Object.freeze({ width: 1536, height: 1024, providerValue: '1536x1024' }),
});

function outputPolicyError(message, details) {
  return new AppError('UNSUPPORTED_MEDIA_OUTPUT', message, { status: 400, details });
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function modalitySettings(settings, modality) {
  const source = object(settings);
  const specific = object(source[modality]);
  return {
    ...(source.aspectRatio ? { aspectRatio: source.aspectRatio } : {}),
    ...specific,
  };
}

function mergeMediaIntent({ modality, platform = PLATFORM_MEDIA_DEFAULTS, user, project, override } = {}) {
  if (!['image', 'video'].includes(modality)) throw new TypeError(`Unsupported media modality: ${modality}`);
  const merged = [platform || PLATFORM_MEDIA_DEFAULTS, user, project, override].reduce((result, layer) => ({ ...result, ...modalitySettings(layer, modality) }), {});
  const aspectRatio = String(merged.aspectRatio || '').trim();
  const resolutionTier = String(merged.resolutionTier || '').trim();
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw outputPolicyError(`Unsupported aspect ratio: ${aspectRatio || 'missing'}`, { modality, aspectRatio });
  if (!RESOLUTION_TIERS.includes(resolutionTier)) throw outputPolicyError(`Unsupported resolution tier: ${resolutionTier || 'missing'}`, { modality, resolutionTier });
  if (modality === 'image') {
    const quality = String(merged.quality || '').trim();
    if (!IMAGE_QUALITY_LEVELS.includes(quality)) throw outputPolicyError(`Unsupported image quality: ${quality || 'missing'}`, { modality, quality });
    return Object.freeze({ aspectRatio, resolutionTier, quality });
  }
  const durationSeconds = merged.durationSeconds == null ? null : Number(merged.durationSeconds);
  if (durationSeconds != null && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    throw outputPolicyError('Video duration must be positive', { modality, durationSeconds: merged.durationSeconds });
  }
  return Object.freeze({ aspectRatio, resolutionTier, ...(durationSeconds == null ? {} : { durationSeconds }) });
}

function scaleGemini(aspectRatio, resolutionTier) {
  const base = GEMINI_DIMENSIONS[aspectRatio];
  if (!base) return null;
  const scale = { draft: 0.5, standard: 1, high: 2, ultra: 4 }[resolutionTier];
  return { width: Math.round(base[0] * scale), height: Math.round(base[1] * scale), providerValue: resolutionTier === 'draft' ? '0.5K' : `${scale}K` };
}

function shortEdgeDimensions(aspectRatio, shortEdge) {
  const [wide, tall] = aspectRatio.split(':').map(Number);
  if (!wide || !tall) return null;
  const landscape = wide >= tall;
  const width = landscape ? Math.round((shortEdge * wide / tall) / 8) * 8 : shortEdge;
  const height = landscape ? shortEdge : Math.round((shortEdge * tall / wide) / 8) * 8;
  return { width, height };
}

function resolveImageOutput({ provider, model, intent }) {
  const requested = Object.freeze({ ...intent });
  if (provider !== 'openai' && provider !== 'stub' && intent.quality !== 'medium') {
    throw outputPolicyError(`${provider}/${model || 'default'} does not expose image quality ${intent.quality}`, { modality: 'image', provider, model: model || null, requested });
  }
  let dimensions;
  let providerSettings;
  if (provider === 'openai') {
    dimensions = intent.resolutionTier === 'standard' ? OPENAI_DIMENSIONS[intent.aspectRatio] : null;
    if (dimensions) providerSettings = { size: dimensions.providerValue, quality: intent.quality };
  } else if (provider === 'gemini') {
    const supportsTiers = String(model || '').includes('3.1-flash-image');
    dimensions = supportsTiers ? scaleGemini(intent.aspectRatio, intent.resolutionTier) : (intent.resolutionTier === 'standard' ? scaleGemini(intent.aspectRatio, 'standard') : null);
    if (dimensions) providerSettings = { imageSize: dimensions.providerValue, aspectRatio: intent.aspectRatio };
  } else if (provider === 'dezgo') {
    dimensions = intent.resolutionTier === 'standard' ? shortEdgeDimensions(intent.aspectRatio, intent.aspectRatio === '1:1' ? 1024 : 768) : null;
    if (dimensions) providerSettings = { width: dimensions.width, height: dimensions.height };
  } else if (provider === 'stub') {
    const edge = { draft: 512, standard: 1024, high: 2048, ultra: 4096 }[intent.resolutionTier];
    dimensions = shortEdgeDimensions(intent.aspectRatio, edge);
    providerSettings = { width: dimensions.width, height: dimensions.height };
  }
  if (!dimensions || !providerSettings) {
    throw outputPolicyError(`${provider}/${model || 'default'} cannot produce ${intent.resolutionTier} images at ${intent.aspectRatio}`, { modality: 'image', provider, model: model || null, requested });
  }
  return Object.freeze({
    requested,
    resolved: Object.freeze({ provider, model: model || null, aspectRatio: intent.aspectRatio, resolutionTier: intent.resolutionTier, quality: intent.quality, width: dimensions.width, height: dimensions.height, providerSettings: Object.freeze(providerSettings) }),
  });
}

function minimaxResolution(model, tier) {
  // Preserve the pre-policy MiniMax default at 768P for now. This means draft and standard are
  // currently aliases for Hailuo; a future tier migration can map image-to-video draft to 512P,
  // while first/last-frame mode must continue rejecting 512P as unsupported by MiniMax.
  const currentHailuo = model === 'MiniMax-Hailuo-02' || /^MiniMax-Hailuo-2(?:\.|$)/.test(String(model || ''));
  if (tier === 'draft' || tier === 'standard') return currentHailuo ? '768P' : '720P';
  if (tier === 'high') return '1080P';
  return null;
}

// Adding a new video provider means registering a resolver here, not adding another branch to a
// growing if/else chain. Each resolver returns { dimensions, providerSettings } or null when the
// requested settings are unsupported.
const VIDEO_OUTPUT_RESOLVERS = Object.freeze({
  ltx(model, intent) {
    const shortEdge = { draft: 480, standard: 720, high: 1080 }[intent.resolutionTier];
    if (!shortEdge || (intent.durationSeconds && intent.durationSeconds > 12)) return null;
    const dimensions = shortEdgeDimensions(intent.aspectRatio, shortEdge);
    return { dimensions, providerSettings: { width: dimensions.width, height: dimensions.height, ...(intent.durationSeconds ? { duration: intent.durationSeconds } : {}) } };
  },
  minimax(model, intent, mode) {
    const resolution = minimaxResolution(model, intent.resolutionTier);
    const duration = intent.durationSeconds || 6;
    if (mode === 'first_last_frame' && model !== 'MiniMax-Hailuo-02') return null;
    if (mode === 'first_last_frame' && !['768P', '1080P'].includes(resolution)) return null;
    if (resolution && duration === 6) return { dimensions: null, providerSettings: { resolution, duration } };
    if (resolution === '768P' && duration === 10) return { dimensions: null, providerSettings: { resolution, duration } };
    return null;
  },
  // Veo only accepts 16:9/9:16, resolution draft/standard->720p, high->1080p, ultra->4k, and a
  // duration of exactly 4, 6, or 8 seconds -- 8 is required once resolution reaches 1080p/4k.
  // https://ai.google.dev/gemini-api/docs/veo (verified 2026-07-20).
  veo(model, intent) {
    if (!['16:9', '9:16'].includes(intent.aspectRatio)) return null;
    const resolution = { draft: '720p', standard: '720p', high: '1080p', ultra: '4k' }[intent.resolutionTier];
    if (!resolution) return null;
    const requiresEightSeconds = resolution === '1080p' || resolution === '4k';
    const duration = intent.durationSeconds ?? (requiresEightSeconds ? 8 : 6);
    if (![4, 6, 8].includes(duration)) return null;
    if (requiresEightSeconds && duration !== 8) return null;
    return { dimensions: null, providerSettings: { aspectRatio: intent.aspectRatio, resolution, duration } };
  },
  stub(model, intent) {
    const shortEdge = { draft: 480, standard: 720, high: 1080, ultra: 2160 }[intent.resolutionTier];
    const dimensions = shortEdgeDimensions(intent.aspectRatio, shortEdge);
    return { dimensions, providerSettings: { width: dimensions.width, height: dimensions.height, duration: intent.durationSeconds || null } };
  },
});

for (const provider of VIDEO_PROVIDERS) {
  if (!VIDEO_OUTPUT_RESOLVERS[provider]) throw new Error(`Video provider "${provider}" is declared in capabilities but has no output resolver in media-output-policy.js`);
}

function resolveVideoOutput({ provider, model, mode = 'image_to_video', intent }) {
  const requested = Object.freeze({ ...intent });
  const resolver = VIDEO_OUTPUT_RESOLVERS[provider];
  if (!resolver) throw outputPolicyError(`No video output resolver is registered for provider: ${provider}`, { modality: 'video', provider, model: model || null, mode, requested });
  const resolved = resolver(model, intent, mode);
  const dimensions = resolved?.dimensions || null;
  const providerSettings = resolved?.providerSettings || null;
  if (!providerSettings) {
    throw outputPolicyError(`${provider}/${model || 'default'}/${mode} cannot produce ${intent.resolutionTier} video at ${intent.aspectRatio}${intent.durationSeconds ? ` for ${intent.durationSeconds}s` : ''}`, { modality: 'video', provider, model: model || null, mode, requested });
  }
  return Object.freeze({
    requested,
    resolved: Object.freeze({ provider, model: model || null, mode, aspectRatio: intent.aspectRatio, resolutionTier: intent.resolutionTier, ...(dimensions || {}), durationSeconds: providerSettings.duration || intent.durationSeconds || null, providerSettings: Object.freeze(providerSettings) }),
  });
}

function estimatedUsage(output) {
  const resolved = output.resolved;
  let providerEstimate = {};
  if (resolved.provider === 'openai') {
    const landscapeOrPortrait = resolved.width !== resolved.height;
    const outputImageTokens = {
      low: landscapeOrPortrait ? 408 : 272,
      medium: landscapeOrPortrait ? 1584 : 1056,
      high: landscapeOrPortrait ? 6240 : 4160,
    }[resolved.quality];
    providerEstimate = { inputTextTokens: 0, inputImageTokens: 0, outputImageTokens };
  } else if (resolved.provider === 'gemini') {
    providerEstimate = { inputTokens: 0, outputTextOrThinkingTokens: 0, outputImageTokens: resolved.resolutionTier === 'draft' ? 747 : resolved.resolutionTier === 'ultra' ? 2000 : 1120 };
  }
  return {
    requestedOutput: output.requested,
    resolvedOutput: output.resolved,
    ...(resolved.width ? { width: resolved.width } : {}),
    ...(resolved.height ? { height: resolved.height } : {}),
    ...(resolved.quality ? { quality: resolved.quality } : {}),
    ...(resolved.durationSeconds ? { seconds: resolved.durationSeconds } : {}),
    ...(resolved.mode ? { generationMode: resolved.mode } : {}),
    resolutionTier: resolved.resolutionTier,
    aspectRatio: resolved.aspectRatio,
    ...(resolved.providerSettings?.resolution ? { resolution: resolved.providerSettings.resolution } : {}),
    ...providerEstimate,
  };
}

module.exports = {
  ASPECT_RATIOS, IMAGE_QUALITY_LEVELS, PLATFORM_MEDIA_DEFAULTS, RESOLUTION_TIERS,
  estimatedUsage, mergeMediaIntent, resolveImageOutput, resolveVideoOutput,
};
