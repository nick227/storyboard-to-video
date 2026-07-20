const { AppError } = require('../../errors');
const { cleanText } = require('../../shared/text');
const { signal, providerError } = require('../http');
const { providerRequestId, providerResult } = require('../result');
const { encodeLocalFileToBase64DataUri, downloadRemoteVideo } = require('./asset-transport');
const { estimatedUsage } = require('../../shared/media-output-policy');

function createMiniMaxAdapter(config, getCancellation) {
  const env = config?.env || process.env;
  const baseUrl = (env.MINIMAX_API_HOST || 'https://api.minimax.io').replace(/\/+$/, '');
  const apiKey = env.MINIMAX_API_KEY || '';
  const defaultModel = env.MINIMAX_VIDEO_MODEL || 'MiniMax-Hailuo-02';

  function headers(includeJson = true) {
    if (!apiKey) {
      throw new AppError('AUTHENTICATION_REQUIRED', 'MINIMAX_API_KEY is not configured', { status: 401, retryable: false });
    }
    return {
      Authorization: `Bearer ${apiKey}`,
      ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async function verify({ model, mode } = {}) {
    if (!apiKey) {
      throw new AppError('NOT_CONFIGURED', 'MiniMax API key is missing', { status: 401, retryable: false });
    }
    return { ok: true, provider: 'minimax', model: model || defaultModel, mode: mode || 'image_to_video' };
  }

  async function prepareAssets(request, transport) {
    const preparedInputs = await Promise.all(
      (request.inputPlan?.included || []).map(async (input) => {
        if (typeof transport?.prepareInput === 'function') {
          return transport.prepareInput(input);
        }
        if (input.assetPath) {
          const base64 = encodeLocalFileToBase64DataUri(input.assetPath);
          return { ...input, transport: { type: 'inline_base64', url: base64 } };
        }
        return input;
      })
    );

    const outputTransport = typeof transport?.prepareOutput === 'function' ? await transport.prepareOutput(request) : { outputPath: request.outputPath };

    return {
      ...request,
      preparedInputs,
      outputTransport,
    };
  }

  async function submit(request) {
    if (!request.outputSelection?.resolved) throw new AppError('MEDIA_OUTPUT_NOT_RESOLVED', 'Video generation requires server-resolved media output', { status: 500 });
    const fetchImpl = config?.fetch || globalThis.fetch;
    const model = request.model || defaultModel;
    const mode = request.generationMode || 'image_to_video';

    // MiniMax's API is remote: it can only accept a real public URL or inline base64 image data,
    // never a path on this server's local disk. The shared asset transport used across all video
    // providers (createLocalVideoAssetTransport) is correct for LTX, which runs locally and reads
    // that path directly -- but for MiniMax, a `local_file`-typed transport result is not itself a
    // usable image reference. Only trust transport.url when the transport explicitly staged the
    // asset as inline_base64/public_url (createStagedAssetAdapter); otherwise encode the local file
    // ourselves rather than sending a raw filesystem path as "first_frame_image"/"last_frame_image".
    function frameImageValue(item) {
      if (!item) return null;
      if (item.transport && item.transport.type !== 'local_file' && item.transport.url) return item.transport.url;
      const localPath = item.transport?.path || item.assetPath;
      return localPath ? encodeLocalFileToBase64DataUri(localPath) : null;
    }

    let firstFrameImage = null;
    let lastFrameImage = null;

    for (const item of request.preparedInputs || []) {
      if (item.role === 'start_frame') firstFrameImage = frameImageValue(item);
      else if (item.role === 'end_frame') lastFrameImage = frameImageValue(item);
    }

    if (mode === 'first_last_frame') {
      if (model !== 'MiniMax-Hailuo-02') throw new AppError('UNSUPPORTED_VIDEO_MODE', `${model} does not support MiniMax first/last-frame generation`, { status: 400 });
      if (!firstFrameImage || !lastFrameImage) throw new AppError('VIDEO_FRAME_REQUIRED', 'MiniMax first/last-frame generation requires both frame images', { status: 400 });
    }

    const payload = {
      model,
      prompt: cleanText(request.prompt, 2_000),
      ...(firstFrameImage ? { first_frame_image: firstFrameImage } : {}),
      ...(lastFrameImage ? { last_frame_image: lastFrameImage } : {}),
      prompt_optimizer: request.promptOptimizer !== false,
      resolution: request.outputSelection.resolved.providerSettings.resolution,
      duration: request.outputSelection.resolved.providerSettings.duration,
      ...(request.seed !== undefined && request.seed !== null ? { seed: Number(request.seed) } : {}),
    };

    const timeoutMs = config?.env?.VIDEO_PROVIDER_TIMEOUT_MS || 60_000;
    const response = await fetchImpl(`${baseUrl}/v1/video_generation`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(payload),
      signal: signal(timeoutMs, getCancellation),
    });

    const rawText = await response.text();
    let body = {};
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch (_) {}

    if (!response.ok) {
      const msg = body?.base_resp?.status_msg || body?.error || rawText || `HTTP ${response.status}`;
      throw providerError('minimax', response.status, msg, response.headers?.get('retry-after') || '');
    }

    if (body?.base_resp?.status_code !== undefined && body?.base_resp?.status_code !== 0) {
      throw new AppError('MINIMAX_ERROR', `MiniMax API error (${body.base_resp.status_code}): ${body.base_resp.status_msg || 'Unknown error'}`, {
        status: 400,
        retryable: false,
      });
    }

    const taskId = body.task_id || body.id;
    if (!taskId) {
      throw new AppError('MALFORMED_RESPONSE', 'MiniMax response missing task_id', { status: 502, retryable: true });
    }

    return {
      provider: 'minimax',
      model,
      state: 'submitted',
      providerTaskId: String(taskId),
      providerOutputId: null,
      outputExpiresAt: null,
      pollAfter: new Date(Date.now() + 3000).toISOString(),
      requestSnapshot: request,
    };
  }

  async function inspect(task) {
    if (!task?.providerTaskId) {
      throw new AppError('INVALID_TASK_ID', 'Task ID is required to inspect MiniMax task', { status: 400 });
    }
    const fetchImpl = config?.fetch || globalThis.fetch;
    const timeoutMs = 30_000;

    const url = `${baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(task.providerTaskId)}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: headers(false),
      signal: signal(timeoutMs, getCancellation),
    });

    const rawText = await response.text();
    let body = {};
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch (_) {}

    if (!response.ok) {
      const msg = body?.base_resp?.status_msg || body?.error || rawText || `HTTP ${response.status}`;
      throw providerError('minimax', response.status, msg, response.headers?.get('retry-after') || '');
    }

    const rawStatus = String(body.status || body.task_status || '').toLowerCase();
    if (body?.base_resp?.status_code !== undefined && body?.base_resp?.status_code !== 0 && !['fail', 'failed', 'error'].includes(rawStatus)) {
      throw new AppError('MINIMAX_ERROR', `MiniMax query error (${body.base_resp.status_code}): ${body.base_resp.status_msg || 'Unknown error'}`, {
        status: 400,
        retryable: false,
      });
    }

    const fileId = body.file_id || body.file?.file_id || body.output_file_id || null;
    const remoteUrl = body.download_url || body.file?.download_url || body.file_url || null;

    if (['success', 'succeeded', 'completed'].includes(rawStatus)) {
      return {
        ...task,
        state: 'completed',
        providerOutputId: fileId ? String(fileId) : remoteUrl || task.providerTaskId,
        remoteUrl,
        response: body,
      };
    }

    if (['fail', 'failed', 'error'].includes(rawStatus)) {
      return {
        ...task,
        state: 'failed',
        error: {
          code: 'MINIMAX_TASK_FAILED',
          message: body.error || body.base_resp?.status_msg || 'MiniMax video generation failed',
        },
        response: body,
      };
    }

    return {
      ...task,
      state: 'running',
      pollAfter: new Date(Date.now() + 3000).toISOString(),
      response: body,
    };
  }

  async function cancel(task) {
    return {
      ...task,
      state: 'cancelled',
    };
  }

  async function fetchResult(task, transport) {
    const fetchImpl = config?.fetch || globalThis.fetch;
    let downloadUrl = task.remoteUrl || task.response?.download_url || task.response?.file?.download_url;

    if (!downloadUrl && task.providerOutputId && !task.providerOutputId.startsWith('http')) {
      const url = `${baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(task.providerOutputId)}`;
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: headers(false),
        signal: signal(30_000, getCancellation),
      });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        downloadUrl = body.file?.download_url || body.download_url;
      }
    }

    if (!downloadUrl) {
      throw new AppError('RESULT_MISSING', `MiniMax task ${task.providerTaskId} completed without returning a valid video URL`, { status: 502, retryable: true });
    }

    const targetPath = task.requestSnapshot?.outputPath || task.outputPath;
    const downloaded = await downloadRemoteVideo(downloadUrl, targetPath, {
      fetch: fetchImpl,
      getCancellation,
      timeoutMs: config?.env?.VIDEO_PROVIDER_TIMEOUT_MS || 300_000,
    });

    return providerResult({
      output: { outputPath: downloaded.outputPath },
      provider: 'minimax',
      model: task.model || defaultModel,
      providerRequestId: task.providerTaskId,
      settings: {
        output: task.requestSnapshot?.outputSelection,
        mode: task.requestSnapshot?.generationMode || 'image_to_video',
        promptOptimizer: task.requestSnapshot?.promptOptimizer !== false,
      },
      usage: { videos: 1, generationMode: task.requestSnapshot?.generationMode || 'image_to_video', ...(task.requestSnapshot?.outputSelection ? estimatedUsage(task.requestSnapshot.outputSelection) : {}) },
      rawUsage: task.response || null,
      measurementStatus: 'observed',
    });
  }

  function normalizeUsage(response) {
    return response;
  }

  return {
    name: 'minimax',
    model: defaultModel,
    verify,
    prepareAssets,
    submit,
    inspect,
    cancel,
    fetchResult,
    normalizeUsage,
  };
}

module.exports = {
  createMiniMaxAdapter,
};
