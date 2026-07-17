const fs = require('node:fs');
const path = require('node:path');
const { signal } = require('../http');
const { cleanText } = require('../../shared/text');
const { stubVideo } = require('../../media/stub-media');
const { AppError } = require('../../errors');
const { providerRequestId, providerResult } = require('../result');

function setting(env, name, fallback, min, max) {
  const value = Number.parseInt(env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function decimalSetting(env, name, fallback, min, max) {
  const value = Number.parseFloat(env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function createVideoProvider(config, getCancellation, usageTracker) {
  const url = (name) => `${config.ltxUrl}${String(name).startsWith('/') ? name : `/${name}`}`;
  const headers = (includeJson = false) => ({
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    ...(config.env.LTX_VIDEO_API_TOKEN ? { Authorization: `Bearer ${config.env.LTX_VIDEO_API_TOKEN}` } : {}),
  });

  async function verify() {
    if (config.videoProvider === 'stub') return { ok: true, provider: 'stub' };
    try {
      const response = await fetch(url(config.env.LTX_VIDEO_HEALTH_PATH || '/ready'), {
        headers: headers(),
        signal: signal(config.env.VIDEO_PREFLIGHT_TIMEOUT_MS || 3000, getCancellation),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = body?.error || {};
        throw new AppError(detail.code || 'NOT_READY', detail.message || `Readiness check returned HTTP ${response.status}`, {
          status: response.status,
          retryable: detail.retryable !== false,
        });
      }
      return { ok: true, provider: 'ltx' };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('NOT_READY', `LTX-Video is unavailable: ${error.message}`, { status: 503, retryable: true, cause: error });
    }
  }

  async function generateCore({ imagePath, prompt, motionIntensity = 'medium', outputPath }) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (config.videoProvider === 'stub') {
      fs.copyFileSync(stubVideo(config), outputPath);
      return providerResult({ output: { outputPath }, provider: 'stub', model: 'stub-video-v1', usage: { videos: 1 }, measurementStatus: 'not_applicable' });
    }

    fs.mkdirSync(config.paths.ltxShared, { recursive: true });
    const extension = path.extname(imagePath) || '.png';
    const base = path.parse(outputPath).name;
    const stagedImage = path.join(config.paths.ltxShared, `${base}-source${extension}`);
    const stagedOutput = path.join(config.paths.ltxShared, path.basename(outputPath));
    fs.copyFileSync(imagePath, stagedImage);
    try {
      const presetFrames = { subtle: 33, medium: 49, high: 65 }[motionIntensity] || 49;
      const frames = setting(config.env, 'VIDEO_FRAMES', presetFrames, 9, 297);
      const response = await fetch(url(config.env.LTX_VIDEO_GENERATE_PATH || '/generate'), {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          prompt: cleanText(prompt, 20_000),
          negative_prompt: cleanText(config.env.VIDEO_NEGATIVE_PROMPT || 'flicker, jitter, blurry, warped anatomy, extra limbs, duplicate characters, text, watermark, frozen frame, static pose', 20_000),
          motion_intensity: ['subtle', 'medium', 'high'].includes(motionIntensity) ? motionIntensity : 'medium',
          image: stagedImage,
          width: setting(config.env, 'VIDEO_WIDTH', 640, 64, 2048),
          height: setting(config.env, 'VIDEO_HEIGHT', 480, 64, 2048),
          frames: (frames - 1) % 8 === 0 ? frames : presetFrames,
          frame_rate: setting(config.env, 'VIDEO_FRAME_RATE', 24, 1, 60),
          steps: setting(config.env, 'VIDEO_STEPS', 30, 5, 100),
          guidance_scale: decimalSetting(config.env, 'VIDEO_GUIDANCE_SCALE', 4, 1, 10),
          seed: setting(config.env, 'VIDEO_SEED', 42, 0, 2 ** 31 - 1),
          output: stagedOutput,
        }),
        signal: signal(config.env.VIDEO_PROVIDER_TIMEOUT_MS || 600000, getCancellation),
      });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      if (!response.ok) {
        const detail = body?.error || {};
        throw new AppError(detail.code || 'LTX_ERROR', detail.message || raw || `LTX-Video returned HTTP ${response.status}`, {
          status: response.status,
          retryable: detail.retryable === true,
        });
      }
      if (!fs.existsSync(stagedOutput)) throw new AppError('LTX_OUTPUT_MISSING', 'LTX-Video completed without creating output', { retryable: true });
      fs.copyFileSync(stagedOutput, outputPath);
      const frameRate = setting(config.env, 'VIDEO_FRAME_RATE', 24, 1, 60);
      return providerResult({ output: { outputPath }, provider: 'ltx', model: config.env.LTX_VIDEO_MODEL || 'ltx-video', providerRequestId: providerRequestId(response, body), usage: { videos: 1, frames, frameRate, seconds: frames / frameRate, steps: setting(config.env, 'VIDEO_STEPS', 30, 5, 100), width: setting(config.env, 'VIDEO_WIDTH', 640, 64, 2048), height: setting(config.env, 'VIDEO_HEIGHT', 480, 64, 2048) }, rawUsage: body?.usage || body || null, measurementStatus: 'observed' });
    } finally {
      fs.rmSync(stagedImage, { force: true });
      fs.rmSync(stagedOutput, { force: true });
    }
  }

  function generate(input) {
    const provider = config.videoProvider === 'stub' ? 'stub' : 'ltx';
    const model = provider === 'stub' ? 'stub-video-v1' : (config.env.LTX_VIDEO_MODEL || 'ltx-video');
    const operation = () => generateCore(input);
    return usageTracker ? usageTracker.execute({ modality: 'video', provider, model, inputMetadata: { promptCharacters: String(input.prompt || '').length, motionIntensity: input.motionIntensity || 'medium' } }, operation) : operation();
  }

  return { generate, verify };
}

module.exports = { createVideoProvider };
