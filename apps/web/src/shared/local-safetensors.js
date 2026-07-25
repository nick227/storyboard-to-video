const LOCAL_SAFETENSORS_PROVIDER = 'local-safetensors';

// Only list checkpoints that exist on the local Windows disk. Flux entries stay out until their
// .safetensors / .gguf files are installed under the Safetensors Image Generator model config.
const LOCAL_SAFETENSORS_MODELS = Object.freeze([
  Object.freeze({ key: 'realistic-stock-photo', label: 'Realistic Stock Photo v2.0' }),
  Object.freeze({ key: 'biglove-xl1', label: 'BigLove XL1' }),
]);

const LOCAL_SAFETENSORS_MODEL_KEYS = Object.freeze(LOCAL_SAFETENSORS_MODELS.map((model) => model.key));

function localSafetensorsConfigured(config) {
  return Boolean(config?.localSafetensors?.enabled && config.localSafetensors?.baseUrl);
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
  encodeLocalSafetensorsSelection,
  localSafetensorsConfigured,
  localSafetensorsSelectOptionsHtml,
  parseImageProviderSelection,
  sizeKeyForAspectRatio,
};
