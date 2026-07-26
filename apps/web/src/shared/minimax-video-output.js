const { AppError } = require('../errors');

/** Cheapest MiniMax testing configuration (~$0.10/video). */
const MINIMAX_TEST_PRESET = Object.freeze({
  model: 'MiniMax-Hailuo-02',
  resolution: '512P',
  duration: 6,
});

/** Production-oriented Hailuo default (separate from the economy test preset). */
const MINIMAX_PRODUCTION_PRESET = Object.freeze({
  model: 'MiniMax-Hailuo-02',
  resolution: '768P',
  duration: 6,
});

const MINIMAX_TEST_PRESET_LABEL = 'Hailuo 02 — Economy Test · 512P · 6s';

const HAILUO_DURATIONS_BY_MODE = Object.freeze({
  image_to_video: Object.freeze({
    '512P': Object.freeze([6, 10]),
    '768P': Object.freeze([6, 10]),
    '1080P': Object.freeze([6]),
  }),
  text_to_video: Object.freeze({
    '512P': Object.freeze([6, 10]),
    '768P': Object.freeze([6, 10]),
    '1080P': Object.freeze([6]),
  }),
  first_last_frame: Object.freeze({
    '768P': Object.freeze([6]),
    '1080P': Object.freeze([6]),
  }),
});

function isHailuoModel(model) {
  return model === 'MiniMax-Hailuo-02' || /^MiniMax-Hailuo-2(?:\.|$)/.test(String(model || ''));
}

function minimaxResolutionForTier(model, tier) {
  if (isHailuoModel(model)) {
    if (tier === 'draft') return MINIMAX_TEST_PRESET.resolution;
    if (tier === 'standard') return MINIMAX_PRODUCTION_PRESET.resolution;
    if (tier === 'high') return '1080P';
    return null;
  }
  if (tier === 'draft' || tier === 'standard') return '720P';
  if (tier === 'high') return '1080P';
  return null;
}

function allowedMiniMaxDurations(model, mode, resolution) {
  if (!isHailuoModel(model)) {
    if (resolution === '720P' || resolution === '1080P') return [6];
    return null;
  }
  const byResolution = HAILUO_DURATIONS_BY_MODE[mode];
  return byResolution?.[resolution] || null;
}

function isMiniMaxOutputSupported({ model, mode, resolution, duration }) {
  const allowed = allowedMiniMaxDurations(model, mode, resolution);
  return Boolean(allowed && allowed.includes(Number(duration)));
}

function assertMiniMaxVideoOutput({ model, mode, resolution, duration }) {
  if (isMiniMaxOutputSupported({ model, mode, resolution, duration })) return;
  if (mode === 'first_last_frame' && resolution === '512P') {
    throw new AppError('UNSUPPORTED_MEDIA_OUTPUT', 'MiniMax first/last-frame mode does not support 512P', {
      status: 400,
      details: { model, mode, resolution, duration },
    });
  }
  throw new AppError(
    'UNSUPPORTED_MEDIA_OUTPUT',
    `MiniMax ${model}/${mode} cannot produce ${resolution} video for ${duration}s`,
    { status: 400, details: { model, mode, resolution, duration } },
  );
}

module.exports = {
  MINIMAX_TEST_PRESET,
  MINIMAX_PRODUCTION_PRESET,
  MINIMAX_TEST_PRESET_LABEL,
  isHailuoModel,
  minimaxResolutionForTier,
  allowedMiniMaxDurations,
  isMiniMaxOutputSupported,
  assertMiniMaxVideoOutput,
};
