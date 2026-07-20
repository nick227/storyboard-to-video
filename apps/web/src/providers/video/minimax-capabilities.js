const { AppError } = require('../../errors');

const MINIMAX_MODEL_CAPABILITIES = Object.freeze({
  'video-01': Object.freeze({
    supportsStartFrame: true,
    supportsEndFrame: false,
    supportsPromptOptimizer: true,
    supportsSubjectReference: false,
    maxReferenceImages: 1,
    execution: 'asynchronous',
  }),
  'video-01-live2d': Object.freeze({
    supportsStartFrame: true,
    supportsEndFrame: false,
    supportsPromptOptimizer: true,
    supportsSubjectReference: false,
    maxReferenceImages: 1,
    execution: 'asynchronous',
  }),
  'video-01-keyframe': Object.freeze({
    supportsStartFrame: true,
    supportsEndFrame: true,
    supportsPromptOptimizer: true,
    supportsSubjectReference: false,
    maxReferenceImages: 2,
    execution: 'asynchronous',
  }),
  'i2v-01-keyframe': Object.freeze({
    supportsStartFrame: true,
    supportsEndFrame: true,
    supportsPromptOptimizer: true,
    supportsSubjectReference: false,
    maxReferenceImages: 2,
    execution: 'asynchronous',
  }),
  't2v-01': Object.freeze({
    supportsStartFrame: false,
    supportsEndFrame: false,
    supportsPromptOptimizer: true,
    supportsSubjectReference: false,
    maxReferenceImages: 0,
    execution: 'asynchronous',
  }),
});

const DEFAULT_MINIMAX_MODEL = 'video-01';

function getMiniMaxModelCapabilities(modelName) {
  const normalizedModel = String(modelName || DEFAULT_MINIMAX_MODEL).toLowerCase();
  const caps = MINIMAX_MODEL_CAPABILITIES[normalizedModel] || MINIMAX_MODEL_CAPABILITIES[DEFAULT_MINIMAX_MODEL];
  return { ...caps, model: normalizedModel };
}

function validateAndPlanMiniMaxInputs({ model = DEFAULT_MINIMAX_MODEL, prompt, startFrame, endFrame, strict = false }) {
  const capabilities = getMiniMaxModelCapabilities(model);
  const consumedInputs = {
    prompt: Boolean(prompt && String(prompt).trim()),
    startFrame: false,
    endFrame: false,
  };
  const excludedInputs = [];

  if (!consumedInputs.prompt) {
    throw new AppError('INVALID_INPUT', 'A non-empty text prompt is required for MiniMax video generation', { status: 400 });
  }

  if (startFrame) {
    if (capabilities.supportsStartFrame) {
      consumedInputs.startFrame = true;
    } else {
      const reason = `Model ${capabilities.model} does not support first-frame image input`;
      if (strict) {
        throw new AppError('UNSUPPORTED_INPUT', reason, { status: 400 });
      }
      excludedInputs.push({ role: 'start_frame', reason });
    }
  }

  if (endFrame) {
    if (capabilities.supportsEndFrame) {
      consumedInputs.endFrame = true;
    } else {
      const reason = `Model ${capabilities.model} does not support last-frame keyframe input`;
      if (strict) {
        throw new AppError('UNSUPPORTED_INPUT', reason, { status: 400 });
      }
      excludedInputs.push({ role: 'end_frame', reason });
    }
  }

  return {
    valid: true,
    model: capabilities.model,
    capabilities,
    consumedInputs,
    excludedInputs,
  };
}

module.exports = {
  DEFAULT_MINIMAX_MODEL,
  MINIMAX_MODEL_CAPABILITIES,
  getMiniMaxModelCapabilities,
  validateAndPlanMiniMaxInputs,
};
