const { randomUUID } = require('node:crypto');
const { AppError } = require('../../errors');
const { providerError } = require('../http');
const { providerResult } = require('../result');
const { estimatedUsage } = require('../../shared/media-output-policy');
const {
  LOCAL_SAFETENSORS_MODEL_KEYS,
  LOCAL_SAFETENSORS_PROVIDER,
  localSafetensorsConfigured,
  sizeKeyForAspectRatio,
} = require('../../shared/local-safetensors');

const TERMINAL = new Set(['completed', 'stopped', 'failed']);

function sleep(ms, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason || new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal.reason || new Error('Aborted'));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function remoteMessage(body, fallback = '') {
  if (!body || typeof body !== 'object') return fallback;
  return String(body.detail || body.error || body.message || fallback);
}

function localError({ model, runId, message, cause, retryable = false, status = 502 }) {
  const parts = [
    `provider=${LOCAL_SAFETENSORS_PROVIDER}`,
    model ? `model=${model}` : null,
    runId != null ? `runId=${runId}` : null,
    message,
  ].filter(Boolean);
  const error = new AppError('PROVIDER_ERROR', parts.join(' · '), { status, retryable });
  if (cause) error.cause = cause;
  return error;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return { message: text }; }
}

function createLocalSafetensorsClient(config, getCancellation) {
  const settings = config.localSafetensors || {};

  function requireConfigured(model) {
    if (!localSafetensorsConfigured(config)) {
      throw localError({ model, message: 'Local Safetensors is not enabled (LOCAL_SAFETENSORS_ENABLED and LOCAL_SAFETENSORS_BASE_URL required)' });
    }
    if (!LOCAL_SAFETENSORS_MODEL_KEYS.includes(model)) {
      throw localError({ model, message: `Unsupported Local Safetensors model (supported: ${LOCAL_SAFETENSORS_MODEL_KEYS.join(', ')})` });
    }
  }

  async function request(path, { method = 'GET', body, abortSignal, model, runId } = {}) {
    let response;
    try {
      response = await fetch(`${settings.baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: abortSignal,
      });
    } catch (cause) {
      const aborted = abortSignal?.aborted || cause?.name === 'AbortError';
      throw localError({
        model,
        runId,
        message: aborted ? 'request aborted or timed out' : `connection failure: ${cause.message || cause}`,
        cause,
        retryable: !aborted,
      });
    }
    const payload = await readJson(response);
    if (!response.ok) {
      throw localError({
        model,
        runId,
        message: remoteMessage(payload, `HTTP ${response.status}`),
        status: response.status === 429 ? 429 : 502,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return payload;
  }

  async function stopRun(runId, session, model) {
    if (runId == null) return;
    try {
      await request(`/api/generation-runs/${runId}/stop`, {
        method: 'POST',
        body: session,
        model,
        runId,
      });
    } catch (_) { /* best-effort cancel */ }
  }

  async function waitForCompletion(runId, session, model, abortSignal) {
    const deadline = Date.now() + settings.timeoutMs;
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) {
        await stopRun(runId, session, model);
        throw localError({ model, runId, message: 'cancelled', status: 499 });
      }
      await request(`/api/generation-runs/${runId}/heartbeat`, {
        method: 'POST',
        body: session,
        abortSignal,
        model,
        runId,
      }).catch(() => null);

      const progress = await request(`/api/generation-runs/${runId}/progress`, {
        abortSignal,
        model,
        runId,
      });
      const status = String(progress.status || '');
      if (TERMINAL.has(status)) return progress;
      await sleep(settings.pollIntervalMs, abortSignal);
    }
    await stopRun(runId, session, model);
    throw localError({ model, runId, message: `timed out after ${settings.timeoutMs}ms` });
  }

  async function fetchCompletedImage(runId, model, abortSignal) {
    const list = await request(`/api/generations?generation_run_id=${encodeURIComponent(runId)}&limit=20&sort=newest`, {
      abortSignal,
      model,
      runId,
    });
    const item = (list.items || []).find((row) => row.status === 'success' && row.web_path);
    if (!item) {
      throw localError({ model, runId, message: 'run finished without a retrievable image' });
    }
    const webPath = String(item.web_path);
    if (!webPath.startsWith('/')) {
      throw localError({ model, runId, message: 'remote image path was not a web URL' });
    }
    let response;
    try {
      response = await fetch(`${settings.baseUrl}${webPath}`, { signal: abortSignal });
    } catch (cause) {
      throw localError({ model, runId, message: `failed to download image: ${cause.message || cause}`, cause });
    }
    if (!response.ok) {
      throw providerError(LOCAL_SAFETENSORS_PROVIDER, response.status, `image download failed for run ${runId}`);
    }
    const mimeType = response.headers.get('content-type') || item.mime_type || 'image/png';
    const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg'
      : mimeType.includes('webp') ? 'webp' : 'png';
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType, extension, generationId: item.id };
  }

  async function generate(prompt, output, model) {
    requireConfigured(model);
    // Enforce LOCAL_SAFETENSORS_TIMEOUT_MS via the poll deadline; only wire job cancellation here
    // so AbortSignal.timeout does not race the cooperative /stop path.
    const abortSignal = getCancellation?.() || undefined;
    const session = { client_id: randomUUID(), owner_tab_id: randomUUID() };
    const size = output?.resolved?.providerSettings?.size
      || sizeKeyForAspectRatio(output?.resolved?.aspectRatio);
    const steps = Number(output?.resolved?.providerSettings?.steps) || 25;
    const startBody = {
      config: {
        count: 1,
        model,
        lora: null,
        loraScale: 1.0,
        size,
        steps,
        randomizeInline: false,
        templates: [{ text: String(prompt), shuffle: false, active: true, name: 'Storyboarder' }],
        negativePrompt: '',
        imageCategoryNames: [],
        imageSubcategoryNames: [],
        variableStrategy: {},
      },
      ...session,
    };

    let runId;
    try {
      const started = await request('/api/generation-runs/start', {
        method: 'POST',
        body: startBody,
        abortSignal,
        model,
      });
      runId = started.runId ?? started.id;
      if (runId == null) throw localError({ model, message: 'start response missing runId' });

      const progress = await waitForCompletion(runId, session, model, abortSignal);
      if (progress.status === 'failed') {
        throw localError({ model, runId, message: remoteMessage(progress, progress.error || 'generation failed') });
      }
      if (progress.status === 'stopped') {
        throw localError({ model, runId, message: progress.stop_reason || 'generation stopped', status: 499 });
      }
      if (Number(progress.completed_count || 0) < 1) {
        throw localError({ model, runId, message: 'run completed with zero successful images' });
      }

      const image = await fetchCompletedImage(runId, model, abortSignal);
      return providerResult({
        output: { buffer: image.buffer, mimeType: image.mimeType, extension: image.extension },
        provider: LOCAL_SAFETENSORS_PROVIDER,
        model,
        providerRequestId: String(runId),
        settings: { output, size, steps, mode: 'text_to_image', externalRunId: runId, generationId: image.generationId },
        usage: { images: 1, ...estimatedUsage(output), steps },
        measurementStatus: 'estimated',
      });
    } catch (error) {
      if (runId != null && (abortSignal?.aborted || /abort|cancel|timed out/i.test(String(error?.message || error?.name || '')))) {
        await stopRun(runId, session, model);
      }
      throw error;
    }
  }

  return { generate, stopRun };
}

module.exports = { createLocalSafetensorsClient };
