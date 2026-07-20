const fs = require('node:fs');
const path = require('node:path');
const { signal } = require('../http');
const { cleanText } = require('../../shared/text');
const { stubVideo } = require('../../media/stub-media');
const { AppError } = require('../../errors');
const { providerRequestId, providerResult } = require('../result');
const { VIDEO_PROVIDER_CAPABILITIES, VIDEO_PROVIDERS, videoProviderCapabilities } = require('../../shared/video-provider-capabilities');
const { estimatedUsage } = require('../../shared/media-output-policy');

function setting(env, name, fallback, min, max) {
  const value = Number.parseInt(env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function decimalSetting(env, name, fallback, min, max) {
  const value = Number.parseFloat(env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function completedTask(provider, model, response) {
  return { provider, model, state: 'completed', providerTaskId: response.providerRequestId || null, response };
}

function createStubAdapter(config) {
  const model = 'stub-video-v1';
  return {
    name: 'stub', model,
    async verify() { return { ok: true, provider: 'stub' }; },
    async prepareAssets(request, transport) {
      return { ...request, preparedInputs: await Promise.all(request.inputPlan.included.map((input) => transport.prepareInput(input))), outputTransport: await transport.prepareOutput(request) };
    },
    async submit(request) {
      if (!request.outputSelection?.resolved) throw new AppError('MEDIA_OUTPUT_NOT_RESOLVED', 'Video generation requires server-resolved media output', { status: 500 });
      fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
      fs.copyFileSync(stubVideo(config), request.outputPath);
      return completedTask('stub', model, providerResult({ output: { outputPath: request.outputPath }, provider: 'stub', model, settings: { output: request.outputSelection, motionIntensity: request.motionIntensity, renderer: 'stub-video-v1' }, usage: { videos: 1, ...estimatedUsage(request.outputSelection) }, measurementStatus: 'not_applicable' }));
    },
    async inspect(task) { return task; },
    async cancel(task) { return { ...task, state: 'cancelled' }; },
    async fetchResult(task) { return task.response; },
    normalizeUsage(response) { return response; },
  };
}

function createLtxAdapter(config, getCancellation) {
  const model = config.env.LTX_VIDEO_MODEL || 'ltx-video';
  const url = (name) => `${config.ltxUrl}${String(name).startsWith('/') ? name : `/${name}`}`;
  const headers = (includeJson = false) => ({
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    ...(config.env.LTX_VIDEO_API_TOKEN ? { Authorization: `Bearer ${config.env.LTX_VIDEO_API_TOKEN}` } : {}),
  });

  async function verify() {
    try {
      const response = await fetch(url(config.env.LTX_VIDEO_HEALTH_PATH || '/ready'), { headers: headers(), signal: signal(config.env.VIDEO_PREFLIGHT_TIMEOUT_MS || 3000, getCancellation) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = body?.error || {};
        throw new AppError(detail.code || 'NOT_READY', detail.message || `Readiness check returned HTTP ${response.status}`, { status: response.status, retryable: detail.retryable !== false });
      }
      return { ok: true, provider: 'ltx' };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('NOT_READY', `LTX-Video is unavailable: ${error.message}`, { status: 503, retryable: true, cause: error });
    }
  }

  async function prepareAssets(request, transport) {
    const preparedInputs = await Promise.all(request.inputPlan.included.map((input) => transport.prepareInput(input)));
    const start = preparedInputs.find((input) => input.role === 'start_frame');
    fs.mkdirSync(config.paths.ltxShared, { recursive: true });
    const extension = path.extname(start.transport.path) || '.png';
    const base = path.parse(request.outputPath).name;
    const stagedImage = path.join(config.paths.ltxShared, `${base}-source${extension}`);
    const stagedOutput = path.join(config.paths.ltxShared, path.basename(request.outputPath));
    fs.copyFileSync(start.transport.path, stagedImage);
    return { ...request, preparedInputs, stagedImage, stagedOutput, outputTransport: await transport.prepareOutput(request) };
  }

  async function submit(request) {
    if (!request.outputSelection?.resolved) throw new AppError('MEDIA_OUTPUT_NOT_RESOLVED', 'Video generation requires server-resolved media output', { status: 500 });
    const presetFrames = { subtle: 121, medium: 121, high: 97 }[request.motionIntensity] || 121;
    const frameRate = setting(config.env, 'VIDEO_FRAME_RATE', 24, 1, 60);
    const requestedFrames = request.outputSelection.resolved.durationSeconds
      ? Math.round((request.outputSelection.resolved.durationSeconds * frameRate - 1) / 8) * 8 + 1
      : null;
    if (requestedFrames && requestedFrames > 297) throw new AppError('UNSUPPORTED_MEDIA_OUTPUT', `LTX duration requires ${requestedFrames} frames, above the configured model limit`, { status: 400, details: { requestedFrames, frameRate } });
    const frames = requestedFrames || setting(config.env, 'VIDEO_FRAMES', presetFrames, 9, 297);
    const { width, height } = request.outputSelection.resolved.providerSettings;
    const steps = setting(config.env, 'VIDEO_STEPS', 45, 5, 100);
    const guidanceScale = decimalSetting(config.env, 'VIDEO_GUIDANCE_SCALE', 2.25, 1, 10);
    const seed = request.inputPlan.output.seed ?? setting(config.env, 'VIDEO_SEED', 42, 0, 2 ** 31 - 1);
    const negativePrompt = cleanText(config.env.VIDEO_NEGATIVE_PROMPT || 'flicker, jitter, blurry, warped anatomy, extra limbs, duplicate characters, text, watermark, frozen frame, static pose', 20_000);
    try {
      const response = await fetch(url(config.env.LTX_VIDEO_GENERATE_PATH || '/generate'), {
        method: 'POST', headers: headers(true),
        body: JSON.stringify({ prompt: cleanText(request.prompt, 20_000), negative_prompt: negativePrompt, motion_intensity: ['subtle', 'medium', 'high'].includes(request.motionIntensity) ? request.motionIntensity : 'medium', image: request.stagedImage, width, height, frames: (frames - 1) % 8 === 0 ? frames : presetFrames, frame_rate: frameRate, steps, guidance_scale: guidanceScale, seed, output: request.stagedOutput }),
        signal: signal(config.env.VIDEO_PROVIDER_TIMEOUT_MS || 600000, getCancellation),
      });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      if (!response.ok) {
        const detail = body?.error || {};
        throw new AppError(detail.code || 'LTX_ERROR', detail.message || raw || `LTX-Video returned HTTP ${response.status}`, { status: response.status, retryable: detail.retryable === true });
      }
      if (!fs.existsSync(request.stagedOutput)) throw new AppError('LTX_OUTPUT_MISSING', 'LTX-Video completed without creating output', { retryable: true });
      fs.copyFileSync(request.stagedOutput, request.outputPath);
      const result = providerResult({ output: { outputPath: request.outputPath }, provider: 'ltx', model, providerRequestId: providerRequestId(response, body), settings: { output: request.outputSelection, motionIntensity: request.motionIntensity, negativePrompt, frames, frameRate, steps, guidanceScale, seed }, usage: { videos: 1, frames, frameRate, seconds: frames / frameRate, steps, ...estimatedUsage(request.outputSelection) }, rawUsage: body?.usage || body || null, measurementStatus: 'observed' });
      return completedTask('ltx', model, result);
    } finally {
      fs.rmSync(request.stagedImage, { force: true });
      fs.rmSync(request.stagedOutput, { force: true });
    }
  }

  return { name: 'ltx', model, verify, prepareAssets, submit, async inspect(task) { return task; }, async cancel(task) { return { ...task, state: 'cancelled' }; }, async fetchResult(task) { return task.response; }, normalizeUsage(response) { return response; } };
}

const { createMiniMaxAdapter } = require('./minimax');
const { createVeoAdapter } = require('./veo');

const VIDEO_ADAPTER_FACTORIES = {
  ltx: (config, getCancellation) => createLtxAdapter(config, getCancellation),
  minimax: (config, getCancellation) => createMiniMaxAdapter(config, getCancellation),
  veo: (config, getCancellation) => createVeoAdapter(config, getCancellation),
  stub: (config) => createStubAdapter(config),
};

function createVideoProviders(config, getCancellation, usageTracker, overrides = {}) {
  const adapters = new Map(VIDEO_PROVIDERS.map((name) => {
    const factory = VIDEO_ADAPTER_FACTORIES[name];
    if (!overrides[name] && !factory) throw new AppError('UNSUPPORTED_VIDEO_PROVIDER', `Video provider "${name}" is declared in capabilities but has no adapter factory`, { status: 500 });
    return [name, overrides[name] || factory(config, getCancellation)];
  }));
  function get(provider) {
    const adapter = adapters.get(provider);
    if (!adapter) throw new AppError('UNSUPPORTED_VIDEO_PROVIDER', `Unsupported video provider: ${provider}`, { status: 400 });
    return adapter;
  }
  function resolve({ provider, model, mode = 'image_to_video' }) {
    const adapter = get(provider);
    const declaredDefault = VIDEO_PROVIDER_CAPABILITIES[provider].defaultModel;
    const resolvedModel = model || adapter.model || declaredDefault;
    const declaredModel = resolvedModel === adapter.model ? declaredDefault : resolvedModel;
    const capabilities = { ...videoProviderCapabilities(provider, declaredModel, mode), model: resolvedModel };
    return { adapter, capabilities: Object.freeze(capabilities), model: resolvedModel, mode };
  }
  return {
    capabilities: VIDEO_PROVIDER_CAPABILITIES,
    get,
    resolve,
    getCapabilities: (provider, model, mode) => videoProviderCapabilities(provider, model, mode),
    async verify({ provider, model, mode }) { const resolved = resolve({ provider, model, mode }); return { ...(await resolved.adapter.verify({ model: resolved.model, mode: resolved.mode })), capabilities: resolved.capabilities }; },
    usageTracker,
  };
}

module.exports = { createVideoProviders };
