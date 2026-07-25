export const LOCAL_SAFETENSORS_PROVIDER = 'local-safetensors';

export function parseImageProviderSelection(provider, model) {
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
