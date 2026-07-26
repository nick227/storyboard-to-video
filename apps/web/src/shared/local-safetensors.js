const LOCAL_SAFETENSORS_PROVIDER = 'local-safetensors';

// Only list checkpoints that exist on the local Windows disk. Flux entries stay out until their
// .safetensors / .gguf files are installed under the Safetensors Image Generator model config.
const LOCAL_SAFETENSORS_MODELS = Object.freeze([
  Object.freeze({ key: 'realistic-stock-photo', label: 'Realistic Stock Photo v2.0' }),
  Object.freeze({ key: 'biglove-xl1', label: 'BigLove XL1' }),
  Object.freeze({ key: 'dreamshaper-xl-lightning', label: 'DreamShaper XL Lightning' }),
  Object.freeze({ key: 'realistic-comic-book', label: 'Realistic Comic Book v10' }),
  Object.freeze({ key: 'another-realistic-comic-mix2', label: 'Another Realistic Comic Mix 2 v10' }),
]);

const LOCAL_SAFETENSORS_MODEL_KEYS = Object.freeze(LOCAL_SAFETENSORS_MODELS.map((model) => model.key));

// SD 1.5 checkpoints (≈2GB) — remote size presets are named keys; square-small = 512².
const LOCAL_SAFETENSORS_SD15_KEYS = Object.freeze(new Set([
  'realistic-comic-book',
  'another-realistic-comic-mix2',
]));

// Image quality select → inference steps (Fooocus-style low / medium / high).
const LOCAL_SAFETENSORS_QUALITY_STEPS = Object.freeze({ low: 8, medium: 30, high: 60 });

function localSafetensorsConfigured(config) {
  return Boolean(config?.localSafetensors?.enabled && config.localSafetensors?.baseUrl);
}

function localSafetensorsRunSettings(model, aspectRatio, resolutionTier, quality = 'medium') {
  const sd15 = LOCAL_SAFETENSORS_SD15_KEYS.has(model);
  return Object.freeze({
    size: sd15 ? 'square-small' : sizeKeyForAspectRatio(aspectRatio),
    steps: LOCAL_SAFETENSORS_QUALITY_STEPS[quality] ?? LOCAL_SAFETENSORS_QUALITY_STEPS.medium,
    shortEdge: sd15 ? 512 : (resolutionTier === 'draft' ? 768 : 1024),
  });
}

function encodeLocalSafetensorsSelection(modelKey) {
  return `${LOCAL_SAFETENSORS_PROVIDER}:${modelKey}`;
}

function parseImageProviderSelection(provider, model) {
  const raw = String(provider || '');
  const prefix = `${LOCAL_SAFETENSORS_PROVIDER}:`;
  if (raw.startsWith(prefix)) {
    return { provider: LOCAL_SAFETENSORS_PROVIDER, model: raw.slice(prefix.length) || null };
  }
  if (raw === LOCAL_SAFETENSORS_PROVIDER) {
    return { provider: LOCAL_SAFETENSORS_PROVIDER, model: model || null };
  }
  return { provider: raw, model: model || null };
}

function localSafetensorsSelectOptionsHtml() {
  return LOCAL_SAFETENSORS_MODELS.map((model) => (
    `<option value="${encodeLocalSafetensorsSelection(model.key)}">Local Safetensors · ${model.label}</option>`
  )).join('\n');
}

function sizeKeyForAspectRatio(aspectRatio) {
  return {
    '1:1': 'square',
    '16:9': 'landscape',
    '9:16': 'portrait',
    '4:3': 'landscape',
    '3:4': 'portrait',
    '3:2': 'landscape',
    '2:3': 'portrait',
  }[aspectRatio] || 'square';
}

module.exports = {
  LOCAL_SAFETENSORS_PROVIDER,
  LOCAL_SAFETENSORS_MODELS,
  LOCAL_SAFETENSORS_MODEL_KEYS,
  LOCAL_SAFETENSORS_SD15_KEYS,
  LOCAL_SAFETENSORS_QUALITY_STEPS,
  encodeLocalSafetensorsSelection,
  localSafetensorsConfigured,
  localSafetensorsRunSettings,
  localSafetensorsSelectOptionsHtml,
  parseImageProviderSelection,
  sizeKeyForAspectRatio,
};
