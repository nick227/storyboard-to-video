const { AppError } = require('../../errors');
const { cleanText } = require('../../shared/text');
const { signal, providerError } = require('../http');
const { providerResult } = require('../result');
const { encodeLocalFileToBase64DataUri, mimeTypeFromExtension, downloadRemoteVideo } = require('./asset-transport');
const { estimatedUsage } = require('../../shared/media-output-policy');

// Veo 3.1 via the Gemini API's predictLongRunning endpoint. Verified against
// https://ai.google.dev/gemini-api/docs/veo (2026-07-20): POST .../models/{model}:predictLongRunning
// returns an operation name, polled at GET .../v1beta/{operation_name} until done, then the video is
// downloaded from response.generateVideoResponse.generatedSamples[0].video.uri. This adapter has not
// been exercised against a live Veo API key -- unlike MiniMax, which is live-validated -- so treat it
// as an architectural scaffold (proving the provider-neutral registry/capability/execution machinery
// accepts a second real provider) pending a real Veo access grant and contract test.
//
// Deliberately not modeled here: Veo's up-to-three `referenceImages` (character/product identity),
// which the request format actually allows alongside image/lastFrame in the same call. Modeling that
// means extending the input-role vocabulary for video the way still-image references already work,
// which is separate scope from proving a second provider fits the existing start/end-frame model.
function createVeoAdapter(config, getCancellation) {
  const env = config?.env || process.env;
  const baseUrl = (env.VEO_API_HOST || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const apiKey = env.GEMINI_API_KEY || '';
  const defaultModel = env.VEO_VIDEO_MODEL || 'veo-3.1-generate-preview';

  function headers() {
    if (!apiKey) throw new AppError('AUTHENTICATION_REQUIRED', 'GEMINI_API_KEY is not configured', { status: 401, retryable: false });
    return { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
  }

  async function verify({ model, mode } = {}) {
    if (!apiKey) throw new AppError('NOT_CONFIGURED', 'GEMINI_API_KEY is missing', { status: 401, retryable: false });
    return { ok: true, provider: 'veo', model: model || defaultModel, mode: mode || 'image_to_video' };
  }

  async function prepareAssets(request, transport) {
    const preparedInputs = await Promise.all(
      (request.inputPlan?.included || []).map(async (input) => {
        if (typeof transport?.prepareInput === 'function') return transport.prepareInput(input);
        return input;
      })
    );
    const outputTransport = typeof transport?.prepareOutput === 'function' ? await transport.prepareOutput(request) : { outputPath: request.outputPath };
    return { ...request, preparedInputs, outputTransport };
  }

  function inlineImage(item) {
    if (!item) return null;
    const filePath = item.transport?.path || item.assetPath;
    if (!filePath) return null;
    const mimeType = mimeTypeFromExtension(filePath);
    const data = item.transport?.url && !item.transport.url.startsWith('data:')
      ? item.transport.url
      : encodeLocalFileToBase64DataUri(filePath, { dataUri: false });
    return { inlineData: { mimeType, data } };
  }

  async function submit(request) {
    if (!request.outputSelection?.resolved) throw new AppError('MEDIA_OUTPUT_NOT_RESOLVED', 'Video generation requires server-resolved media output', { status: 500 });
    const fetchImpl = config?.fetch || globalThis.fetch;
    const model = request.model || defaultModel;
    const mode = request.generationMode || 'image_to_video';

    let startItem = null;
    let endItem = null;
    for (const item of request.preparedInputs || []) {
      if (item.role === 'start_frame') startItem = item;
      else if (item.role === 'end_frame') endItem = item;
    }

    if (mode === 'first_last_frame' && (!startItem || !endItem)) {
      throw new AppError('VIDEO_FRAME_REQUIRED', 'Veo first/last-frame generation requires both frame images', { status: 400 });
    }

    const { resolution, aspectRatio, duration } = request.outputSelection.resolved.providerSettings;
    const payload = {
      instances: [{
        prompt: cleanText(request.prompt, 2_000),
        ...(startItem ? { image: inlineImage(startItem) } : {}),
        ...(endItem ? { lastFrame: inlineImage(endItem) } : {}),
      }],
      parameters: { aspectRatio, resolution, durationSeconds: String(duration) },
    };

    const timeoutMs = env.VIDEO_PROVIDER_TIMEOUT_MS || 60_000;
    const response = await fetchImpl(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`, {
      method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: signal(timeoutMs, getCancellation),
    });

    const rawText = await response.text();
    let body = {};
    try { body = rawText ? JSON.parse(rawText) : {}; } catch (_) {}

    if (!response.ok) {
      const msg = body?.error?.message || rawText || `HTTP ${response.status}`;
      throw providerError('veo', response.status, msg, response.headers?.get('retry-after') || '');
    }

    const operationName = body.name;
    if (!operationName) throw new AppError('MALFORMED_RESPONSE', 'Veo response missing operation name', { status: 502, retryable: true });

    return {
      provider: 'veo', model, state: 'submitted',
      providerTaskId: String(operationName), providerOutputId: null, outputExpiresAt: null,
      pollAfter: new Date(Date.now() + 10_000).toISOString(),
      requestSnapshot: request,
    };
  }

  async function inspect(task) {
    if (!task?.providerTaskId) throw new AppError('INVALID_TASK_ID', 'Task ID is required to inspect Veo task', { status: 400 });
    const fetchImpl = config?.fetch || globalThis.fetch;
    const response = await fetchImpl(`${baseUrl}/v1beta/${task.providerTaskId}`, { method: 'GET', headers: headers(), signal: signal(30_000, getCancellation) });

    const rawText = await response.text();
    let body = {};
    try { body = rawText ? JSON.parse(rawText) : {}; } catch (_) {}

    if (!response.ok) {
      const msg = body?.error?.message || rawText || `HTTP ${response.status}`;
      throw providerError('veo', response.status, msg, response.headers?.get('retry-after') || '');
    }

    if (body.done && body.error) {
      return { ...task, state: 'failed', error: { code: 'VEO_TASK_FAILED', message: body.error.message || 'Veo video generation failed' }, response: body };
    }

    if (body.done) {
      const videoUri = body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!videoUri) return { ...task, state: 'failed', error: { code: 'VEO_TASK_FAILED', message: 'Veo operation completed without a video sample' }, response: body };
      return { ...task, state: 'completed', providerOutputId: videoUri, remoteUrl: videoUri, response: body };
    }

    return { ...task, state: 'running', pollAfter: new Date(Date.now() + 10_000).toISOString(), response: body };
  }

  async function cancel(task) {
    return { ...task, state: 'cancelled' };
  }

  async function fetchResult(task) {
    const fetchImpl = config?.fetch || globalThis.fetch;
    const downloadUrl = task.remoteUrl;
    if (!downloadUrl) throw new AppError('RESULT_MISSING', `Veo task ${task.providerTaskId} completed without returning a valid video URI`, { status: 502, retryable: true });

    const targetPath = task.requestSnapshot?.outputPath || task.outputPath;
    const downloaded = await downloadRemoteVideo(downloadUrl, targetPath, {
      fetch: fetchImpl, getCancellation, headers: { 'x-goog-api-key': apiKey },
      timeoutMs: env.VIDEO_PROVIDER_TIMEOUT_MS || 300_000,
    });

    return providerResult({
      output: { outputPath: downloaded.outputPath },
      provider: 'veo',
      model: task.model || defaultModel,
      providerRequestId: task.providerTaskId,
      settings: { output: task.requestSnapshot?.outputSelection, mode: task.requestSnapshot?.generationMode || 'image_to_video' },
      usage: { videos: 1, generationMode: task.requestSnapshot?.generationMode || 'image_to_video', ...(task.requestSnapshot?.outputSelection ? estimatedUsage(task.requestSnapshot.outputSelection) : {}) },
      rawUsage: task.response || null,
      measurementStatus: 'observed',
    });
  }

  function normalizeUsage(response) { return response; }

  return { name: 'veo', model: defaultModel, verify, prepareAssets, submit, inspect, cancel, fetchResult, normalizeUsage };
}

module.exports = { createVeoAdapter };
