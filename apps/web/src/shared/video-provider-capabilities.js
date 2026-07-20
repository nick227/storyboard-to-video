const VIDEO_GENERATION_MODES = Object.freeze([
  'text_to_video',
  'image_to_video',
  'first_last_frame',
  'reference_to_video',
  'video_extension',
  'video_edit',
]);

const VIDEO_INPUT_ROLES = Object.freeze([
  'start_frame',
  'end_frame',
  'character',
  'location',
  'composition',
  'motion_reference',
  'reference_video',
  'reference_audio',
]);

const IMAGE_TO_VIDEO = Object.freeze({
  implemented: true,
  execution: 'immediate',
  requiredRoles: Object.freeze(['start_frame']),
  supportedRoles: Object.freeze(['start_frame']),
  maxInputs: 1,
  supportsNativeAudio: false,
});

const MINIMAX_IMAGE_TO_VIDEO = Object.freeze({
  implemented: true,
  execution: 'asynchronous',
  requiredRoles: Object.freeze(['start_frame']),
  supportedRoles: Object.freeze(['start_frame']),
  maxInputs: 1,
  supportsNativeAudio: false,
});

const MINIMAX_TEXT_TO_VIDEO = Object.freeze({
  implemented: true,
  execution: 'asynchronous',
  requiredRoles: Object.freeze([]),
  supportedRoles: Object.freeze([]),
  maxInputs: 0,
  supportsNativeAudio: false,
});

const MINIMAX_FIRST_LAST_FRAME = Object.freeze({
  implemented: true,
  execution: 'asynchronous',
  requiredRoles: Object.freeze(['start_frame', 'end_frame']),
  supportedRoles: Object.freeze(['start_frame', 'end_frame']),
  maxInputs: 2,
  supportsNativeAudio: false,
});

const VEO_IMAGE_TO_VIDEO = Object.freeze({
  implemented: true,
  execution: 'asynchronous',
  requiredRoles: Object.freeze(['start_frame']),
  supportedRoles: Object.freeze(['start_frame']),
  maxInputs: 1,
  supportsNativeAudio: true,
});

const VEO_FIRST_LAST_FRAME = Object.freeze({
  implemented: true,
  execution: 'asynchronous',
  requiredRoles: Object.freeze(['start_frame', 'end_frame']),
  supportedRoles: Object.freeze(['start_frame', 'end_frame']),
  maxInputs: 2,
  supportsNativeAudio: true,
});

const VIDEO_PROVIDER_CAPABILITIES = Object.freeze({
  ltx: Object.freeze({
    defaultModel: 'ltx-video',
    models: Object.freeze({
      'ltx-video': Object.freeze({ modes: Object.freeze({ image_to_video: IMAGE_TO_VIDEO }) }),
    }),
  }),
  minimax: Object.freeze({
    defaultModel: 'MiniMax-Hailuo-02',
    models: Object.freeze({
      'MiniMax-Hailuo-02': Object.freeze({
        modes: Object.freeze({
          image_to_video: MINIMAX_IMAGE_TO_VIDEO,
          text_to_video: MINIMAX_TEXT_TO_VIDEO,
          first_last_frame: MINIMAX_FIRST_LAST_FRAME,
        }),
      }),
      // Retained for existing projects that explicitly selected a legacy model. These models do
      // not gain end-frame support merely because the current Hailuo model has it.
      'video-01': Object.freeze({
        modes: Object.freeze({
          image_to_video: MINIMAX_IMAGE_TO_VIDEO,
          text_to_video: MINIMAX_TEXT_TO_VIDEO,
        }),
      }),
      'video-01-live2d': Object.freeze({
        modes: Object.freeze({
          image_to_video: MINIMAX_IMAGE_TO_VIDEO,
        }),
      }),
    }),
  }),
  // Second commercial provider, added to test whether this capability model is genuinely
  // provider-neutral. Not yet live-validated against a real Veo API key (unlike minimax); see
  // providers/video/veo.js. Veo's up-to-three referenceImages (character/product identity) are not
  // modeled as a mode here -- that needs the video input-role vocabulary extended, separate scope
  // from proving a second provider fits.
  veo: Object.freeze({
    defaultModel: 'veo-3.1-generate-preview',
    models: Object.freeze({
      'veo-3.1-generate-preview': Object.freeze({
        modes: Object.freeze({
          image_to_video: VEO_IMAGE_TO_VIDEO,
          first_last_frame: VEO_FIRST_LAST_FRAME,
        }),
      }),
    }),
  }),
  stub: Object.freeze({
    defaultModel: 'stub-video-v1',
    models: Object.freeze({
      'stub-video-v1': Object.freeze({ modes: Object.freeze({ image_to_video: IMAGE_TO_VIDEO }) }),
    }),
  }),
});

const VIDEO_PROVIDERS = Object.freeze(Object.keys(VIDEO_PROVIDER_CAPABILITIES));

function videoProviderCapabilities(provider, model, mode = 'image_to_video') {
  const providerCapabilities = VIDEO_PROVIDER_CAPABILITIES[provider];
  if (!providerCapabilities) throw new RangeError(`Unsupported video provider: ${provider}`);
  const resolvedModel = model || providerCapabilities.defaultModel;
  const modelCapabilities = providerCapabilities.models[resolvedModel];
  if (!modelCapabilities) throw new RangeError(`Unsupported video model for ${provider}: ${resolvedModel}`);
  if (!VIDEO_GENERATION_MODES.includes(mode)) throw new RangeError(`Unsupported video generation mode: ${mode}`);
  const modeCapabilities = modelCapabilities.modes[mode];
  if (!modeCapabilities?.implemented) throw new RangeError(`${provider}/${resolvedModel} does not implement video mode: ${mode}`);
  return Object.freeze({
    provider,
    model: resolvedModel,
    mode,
    ...modeCapabilities,
    // Compatibility fields retained while callers migrate to role-aware capabilities.
    supportsStartFrame: modeCapabilities.supportedRoles.includes('start_frame'),
    supportsEndFrame: modeCapabilities.supportedRoles.includes('end_frame'),
    maxReferenceImages: modeCapabilities.supportedRoles.some((role) => ['character', 'location', 'composition'].includes(role))
      ? modeCapabilities.maxInputs
      : 0,
    execution: modeCapabilities.execution === 'immediate' ? 'synchronous' : modeCapabilities.execution,
  });
}

module.exports = { VIDEO_GENERATION_MODES, VIDEO_INPUT_ROLES, VIDEO_PROVIDER_CAPABILITIES, VIDEO_PROVIDERS, videoProviderCapabilities };
