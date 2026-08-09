export const VIDEO_GENERATION_MODES = Object.freeze(['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video', 'video_extension', 'video_edit']);
export const VIDEO_INPUT_ROLES = Object.freeze(['start_frame', 'end_frame', 'character', 'location', 'composition', 'motion_reference', 'reference_video', 'reference_audio']);

export const MINIMAX_TEST_PRESET = Object.freeze({
  model: 'MiniMax-Hailuo-02',
  resolution: '512P',
  duration: 6,
});
export const MINIMAX_TEST_PRESET_LABEL = 'Hailuo 02 — Economy Test · 512P · 6s';

const IMAGE_TO_VIDEO = Object.freeze({ implemented: true, execution: 'immediate', requiredRoles: Object.freeze(['start_frame']), supportedRoles: Object.freeze(['start_frame']), maxInputs: 1, supportsNativeAudio: false });
const H3_IMAGE_TO_VIDEO = Object.freeze({ implemented: true, execution: 'immediate', requiredRoles: Object.freeze(['start_frame']), supportedRoles: Object.freeze(['start_frame']), maxInputs: 1, supportsNativeAudio: true });
const H3_FIRST_LAST_FRAME = Object.freeze({ implemented: true, execution: 'immediate', requiredRoles: Object.freeze(['start_frame', 'end_frame']), supportedRoles: Object.freeze(['start_frame', 'end_frame']), maxInputs: 2, supportsNativeAudio: true });
const MINIMAX_IMAGE_TO_VIDEO = Object.freeze({ implemented: true, execution: 'asynchronous', requiredRoles: Object.freeze(['start_frame']), supportedRoles: Object.freeze(['start_frame']), maxInputs: 1, supportsNativeAudio: false });
const MINIMAX_TEXT_TO_VIDEO = Object.freeze({ implemented: true, execution: 'asynchronous', requiredRoles: Object.freeze([]), supportedRoles: Object.freeze([]), maxInputs: 0, supportsNativeAudio: false });
const MINIMAX_FIRST_LAST_FRAME = Object.freeze({ implemented: true, execution: 'asynchronous', requiredRoles: Object.freeze(['start_frame', 'end_frame']), supportedRoles: Object.freeze(['start_frame', 'end_frame']), maxInputs: 2, supportsNativeAudio: false });
const VEO_IMAGE_TO_VIDEO = Object.freeze({ implemented: true, execution: 'asynchronous', requiredRoles: Object.freeze(['start_frame']), supportedRoles: Object.freeze(['start_frame']), maxInputs: 1, supportsNativeAudio: true });
const VEO_FIRST_LAST_FRAME = Object.freeze({ implemented: true, execution: 'asynchronous', requiredRoles: Object.freeze(['start_frame', 'end_frame']), supportedRoles: Object.freeze(['start_frame', 'end_frame']), maxInputs: 2, supportsNativeAudio: true });

export const VIDEO_PROVIDER_CAPABILITIES = Object.freeze({
  ltx: Object.freeze({ defaultModel: 'ltx-video', models: Object.freeze({ 'ltx-video': Object.freeze({ modes: Object.freeze({ image_to_video: IMAGE_TO_VIDEO }) }) }) }),
  'minimax-h3': Object.freeze({
    defaultModel: 'minimax-h3-fl2va',
    models: Object.freeze({
      'minimax-h3-fl2va': Object.freeze({ modes: Object.freeze({ image_to_video: H3_IMAGE_TO_VIDEO, first_last_frame: H3_FIRST_LAST_FRAME }) }),
    }),
  }),
  minimax: Object.freeze({
    defaultModel: MINIMAX_TEST_PRESET.model,
    models: Object.freeze({
      'MiniMax-Hailuo-02': Object.freeze({ modes: Object.freeze({ image_to_video: MINIMAX_IMAGE_TO_VIDEO, text_to_video: MINIMAX_TEXT_TO_VIDEO, first_last_frame: MINIMAX_FIRST_LAST_FRAME }) }),
      'video-01': Object.freeze({ modes: Object.freeze({ image_to_video: MINIMAX_IMAGE_TO_VIDEO, text_to_video: MINIMAX_TEXT_TO_VIDEO }) }),
      'video-01-live2d': Object.freeze({ modes: Object.freeze({ image_to_video: MINIMAX_IMAGE_TO_VIDEO }) }),
    }),
  }),
  veo: Object.freeze({
    defaultModel: 'veo-3.1-generate-preview',
    models: Object.freeze({
      'veo-3.1-generate-preview': Object.freeze({ modes: Object.freeze({ image_to_video: VEO_IMAGE_TO_VIDEO, first_last_frame: VEO_FIRST_LAST_FRAME }) }),
    }),
  }),
  stub: Object.freeze({ defaultModel: 'stub-video-v1', models: Object.freeze({ 'stub-video-v1': Object.freeze({ modes: Object.freeze({ image_to_video: IMAGE_TO_VIDEO }) }) }) }),
});

export function videoProviderCapabilities(provider, model, mode = 'image_to_video') {
  const providerCapabilities = VIDEO_PROVIDER_CAPABILITIES[provider];
  if (!providerCapabilities) throw new RangeError(`Unsupported video provider: ${provider}`);
  const resolvedModel = model || providerCapabilities.defaultModel;
  const modelCapabilities = providerCapabilities.models[resolvedModel];
  if (!modelCapabilities) throw new RangeError(`Unsupported video model for ${provider}: ${resolvedModel}`);
  if (!VIDEO_GENERATION_MODES.includes(mode)) throw new RangeError(`Unsupported video generation mode: ${mode}`);
  const capabilities = modelCapabilities.modes[mode];
  if (!capabilities?.implemented) throw new RangeError(`${provider}/${resolvedModel} does not implement video mode: ${mode}`);
  return Object.freeze({
    provider, model: resolvedModel, mode, ...capabilities,
    supportsStartFrame: capabilities.supportedRoles.includes('start_frame'),
    supportsEndFrame: capabilities.supportedRoles.includes('end_frame'),
    maxReferenceImages: capabilities.supportedRoles.some((role) => ['character', 'location', 'composition'].includes(role))
      ? capabilities.maxInputs
      : 0,
    execution: capabilities.execution === 'immediate' ? 'synchronous' : capabilities.execution,
  });
}
