export const VIDEO_PROVIDER_CAPABILITIES = Object.freeze({
  ltx: Object.freeze({ supportsStartFrame: true, supportsEndFrame: false, maxReferenceImages: 0, execution: 'synchronous' }),
  stub: Object.freeze({ supportsStartFrame: true, supportsEndFrame: false, maxReferenceImages: 0, execution: 'synchronous' }),
});

export function videoProviderCapabilities(provider) {
  const capabilities = VIDEO_PROVIDER_CAPABILITIES[provider];
  if (!capabilities) throw new RangeError(`Unsupported video provider: ${provider}`);
  return capabilities;
}
