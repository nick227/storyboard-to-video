const fs = require('node:fs');
const path = require('node:path');
const { signal } = require('../http');
const { cleanText } = require('../../shared/text');
const { AppError } = require('../../errors');
const { providerRequestId, providerResult } = require('../result');
const { estimatedUsage } = require('../../shared/media-output-policy');

function completedTask(provider, model, response) {
  return { provider, model, state: 'completed', providerTaskId: response.providerRequestId || null, response };
}

function createMiniMaxH3Adapter(config, getCancellation) {
  const model = config.env.H3_VIDEO_MODEL || 'minimax-h3-fl2va';
  const baseUrl = (config.h3Url || config.env.H3_VIDEO_URL || 'http://localhost:8010').replace(/\/+$/, '');
  const url = (name) => `${baseUrl}${String(name).startsWith('/') ? name : `/${name}`}`;
  const headers = (includeJson = false) => ({
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    ...(config.env.H3_VIDEO_API_TOKEN ? { Authorization: `Bearer ${config.env.H3_VIDEO_API_TOKEN}` } : {}),
  });
  const fetchImpl = config.fetch || fetch;

  async function verify() {
    try {
      const response = await fetchImpl(url(config.env.H3_VIDEO_HEALTH_PATH || '/ready'), {
        headers: headers(),
        signal: signal(config.env.VIDEO_PREFLIGHT_TIMEOUT_MS || 3000, getCancellation),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = body?.error || body?.detail || {};
        const message = typeof detail === 'string' ? detail : (detail.message || `Readiness check returned HTTP ${response.status}`);
        throw new AppError(detail.code || 'NOT_READY', message, { status: response.status, retryable: detail.retryable !== false });
      }
      return { ok: true, provider: 'minimax-h3' };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('NOT_READY', `MiniMax H3 is unavailable: ${error.message}`, { status: 503, retryable: true, cause: error });
    }
  }

  async function prepareAssets(request, transport) {
    const preparedInputs = await Promise.all(request.inputPlan.included.map((input) => transport.prepareInput(input)));
    const start = preparedInputs.find((input) => input.role === 'start_frame');
    const end = preparedInputs.find((input) => input.role === 'end_frame');
    fs.mkdirSync(config.paths.h3Shared, { recursive: true });
    const base = path.parse(request.outputPath).name;
    const extension = path.extname(start.transport.path) || '.png';
    const stagedImage = path.join(config.paths.h3Shared, `${base}-source${extension}`);
    const stagedOutput = path.join(config.paths.h3Shared, path.basename(request.outputPath));
    fs.copyFileSync(start.transport.path, stagedImage);
    let stagedEndImage = null;
    if (end?.transport?.path) {
      const endExt = path.extname(end.transport.path) || '.png';
      stagedEndImage = path.join(config.paths.h3Shared, `${base}-end${endExt}`);
      fs.copyFileSync(end.transport.path, stagedEndImage);
    }
    return {
      ...request,
      preparedInputs,
      stagedImage,
      stagedEndImage,
      stagedOutput,
      outputTransport: await transport.prepareOutput(request),
    };
  }

  async function submit(request) {
    if (!request.outputSelection?.resolved) {
      throw new AppError('MEDIA_OUTPUT_NOT_RESOLVED', 'Video generation requires server-resolved media output', { status: 500 });
    }
    const { width, height } = request.outputSelection.resolved.providerSettings;
    const durationSeconds = request.outputSelection.resolved.durationSeconds || request.outputSelection.resolved.providerSettings.duration || 5;
    const steps = Number.parseInt(config.env.H3_VIDEO_STEPS || config.env.VIDEO_STEPS || '20', 10);
    const seed = request.inputPlan.output.seed ?? Number.parseInt(config.env.VIDEO_SEED || '42', 10);
    const body = {
      prompt: cleanText(request.prompt, 20_000),
      image: request.stagedImage,
      width,
      height,
      duration: durationSeconds,
      steps: Number.isInteger(steps) ? steps : 20,
      seed: Number.isInteger(seed) ? seed : 42,
      output: request.stagedOutput,
    };
    if (request.stagedEndImage) body.end_image = request.stagedEndImage;

    try {
      const response = await fetchImpl(url(config.env.H3_VIDEO_GENERATE_PATH || '/generate'), {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(body),
        signal: signal(config.env.VIDEO_PROVIDER_TIMEOUT_MS || 1_800_000, getCancellation),
      });
      const raw = await response.text();
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) {}
      if (!response.ok) {
        const detail = parsed?.error || parsed?.detail || {};
        const message = typeof detail === 'string' ? detail : (detail.message || raw || `MiniMax H3 returned HTTP ${response.status}`);
        throw new AppError(detail.code || 'H3_ERROR', message, { status: response.status, retryable: detail.retryable === true });
      }
      if (!fs.existsSync(request.stagedOutput)) {
        throw new AppError('H3_OUTPUT_MISSING', 'MiniMax H3 completed without creating output', { retryable: true });
      }
      fs.copyFileSync(request.stagedOutput, request.outputPath);
      const usage = parsed.usage || {};
      const result = providerResult({
        output: { outputPath: request.outputPath },
        provider: 'minimax-h3',
        model,
        providerRequestId: providerRequestId(response, parsed) || parsed.prompt_id || null,
        settings: {
          output: request.outputSelection,
          motionIntensity: request.motionIntensity,
          durationSeconds,
          steps: body.steps,
          seed: body.seed,
          hasEndFrame: Boolean(request.stagedEndImage),
        },
        usage: {
          videos: 1,
          frames: usage.frames,
          frameRate: usage.frameRate || 24,
          seconds: usage.seconds || durationSeconds,
          steps: body.steps,
          ...estimatedUsage(request.outputSelection),
        },
        rawUsage: usage,
        measurementStatus: 'observed',
      });
      return completedTask('minimax-h3', model, result);
    } finally {
      fs.rmSync(request.stagedImage, { force: true });
      if (request.stagedEndImage) fs.rmSync(request.stagedEndImage, { force: true });
      fs.rmSync(request.stagedOutput, { force: true });
    }
  }

  return {
    name: 'minimax-h3',
    model,
    verify,
    prepareAssets,
    submit,
    async inspect(task) { return task; },
    async cancel(task) { return { ...task, state: 'cancelled' }; },
    async fetchResult(task) { return task.response; },
    normalizeUsage(response) { return response; },
  };
}

module.exports = { createMiniMaxH3Adapter };
