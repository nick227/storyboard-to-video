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
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
  return String(body.detail || body.error || body.message || body.stop_reason || fallback);
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

function throwCancelled({ model, runId, abortSignal }) {
  const reason = abortSignal?.reason;
  if (reason && typeof reason === 'object' && reason.code === 'JOB_CANCELLED') throw reason;
  throw new AppError('JOB_CANCELLED', 'Generation job cancelled', {
    status: 409,
    details: { provider: LOCAL_SAFETENSORS_PROVIDER, model, runId },
  });
}

function assertFetchableWebPath(webPath, { model, runId }) {
  const value = String(webPath || '');
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://') || /\\|[A-Za-z]:/.test(value) || /localhost|127\.0\.0\.1/i.test(value)) {
    throw localError({ model, runId, message: 'remote image path was not a relative web path under the configured base URL' });
  }
  return value;
}

function combineSignal(abortSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout;
}

function isTransientFetchFailure(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  return name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|network|ECONN|fetch failed|socket/i.test(message);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return { message: text }; }
}

function createLocalSafetensorsClient(config, getCancellation) {
  const settings = config.localSafetensors || {};
  const requestTimeoutMs = Math.min(settings.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);

  function requireConfigured(model) {
    if (!localSafetensorsConfigured(config)) {
      throw localError({ model, message: 'Local Safetensors is not enabled (LOCAL_SAFETENSORS_ENABLED and LOCAL_SAFETENSORS_BASE_URL required)' });
    }
    if (!LOCAL_SAFETENSORS_MODEL_KEYS.includes(model)) {
      throw localError({ model, message: `Unsupported Local Safetensors model (supported: ${LOCAL_SAFETENSORS_MODEL_KEYS.join(', ')})` });
    }
  }

  async function request(path, { method = 'GET', body, abortSignal, model, runId } = {}) {
    const signal = combineSignal(abortSignal, requestTimeoutMs);
    let response;
    try {
      response = await fetch(`${settings.baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (cause) {
      if (abortSignal?.aborted) throwCancelled({ model, runId, abortSignal });
      throw localError({
        model,
        runId,
        message: isTransientFetchFailure(cause)
          ? `connection timeout/failure talking to ${settings.baseUrl}: ${cause.message || cause}`
          : `connection failure: ${cause.message || cause}`,
        cause,
        retryable: true,
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
    if (runId == null) return false;
    try {
      await request(`/api/generation-runs/${runId}/stop`, {
        method: 'POST',
        body: session,
        model,
        runId,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function waitForCompletion(runId, session, model, abortSignal) {
    const deadline = Date.now() + settings.timeoutMs;
    let lastLogAt = 0;
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) {
        await stopRun(runId, session, model);
        throwCancelled({ model, runId, abortSignal });
      }

      try {
        await request(`/api/generation-runs/${runId}/heartbeat`, {
          method: 'POST',
          body: session,
          abortSignal,
          model,
          runId,
        });
      } catch (error) {
        if (abortSignal?.aborted) throwCancelled({ model, runId, abortSignal });
        // Heartbeat loss is recoverable within the overall timeout; keep polling progress.
        if (!error?.retryable && !isTransientFetchFailure(error?.cause || error)) throw error;
      }

      let progress;
      try {
        progress = await request(`/api/generation-runs/${runId}/progress`, {
          abortSignal,
          model,
          runId,
        });
      } catch (error) {
        if (abortSignal?.aborted) throwCancelled({ model, runId, abortSignal });
        if (Date.now() >= deadline) throw error;
        if (error?.retryable || isTransientFetchFailure(error?.cause || error)) {
          await sleep(settings.pollIntervalMs, abortSignal).catch(() => {});
          continue;
        }
        throw error;
      }

      const status = String(progress.status || '');
      const now = Date.now();
      if (now - lastLogAt >= 5_000) {
        lastLogAt = now;
        console.log(
          `[local-safetensors] run=${runId} status=${status} phase=${progress.phase || '-'} `
          + `step=${progress.inference_step ?? '-'} pct=${progress.image_percent ?? progress.run_percent ?? '-'}`,
        );
      }
      if (TERMINAL.has(status)) return progress;
      try {
        await sleep(settings.pollIntervalMs, abortSignal);
      } catch (error) {
        await stopRun(runId, session, model);
        if (abortSignal?.aborted) throwCancelled({ model, runId, abortSignal });
        throw error;
      }
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
    const webPath = assertFetchableWebPath(item.web_path, { model, runId });
    let response;
    try {
      response = await fetch(`${settings.baseUrl}${webPath}`, { signal: combineSignal(abortSignal, requestTimeoutMs) });
    } catch (cause) {
      if (abortSignal?.aborted) throwCancelled({ model, runId, abortSignal });
      throw localError({ model, runId, message: `failed to download image: ${cause.message || cause}`, cause });
    }
    if (!response.ok) {
      throw providerError(LOCAL_SAFETENSORS_PROVIDER, response.status, `image download failed for run ${runId}`);
    }
    const mimeType = response.headers.get('content-type') || item.mime_type || 'image/png';
    const extension = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg'
      : mimeType.includes('webp') ? 'webp' : 'png';
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType,
      extension,
      generationId: item.id,
      sourceUrl: `${settings.baseUrl}${webPath}`,
    };
  }

  async function generate(prompt, output, model) {
    requireConfigured(model);
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
    let stopRequested = false;
    const requestStop = async () => {
      stopRequested = true;
      await stopRun(runId, session, model);
    };

    try {
      const started = await request('/api/generation-runs/start', {
        method: 'POST',
        body: startBody,
        abortSignal,
        model,
      });
      runId = started.runId ?? started.id;
      if (runId == null) throw localError({ model, message: 'start response missing runId' });
      console.log(`[local-safetensors] started run=${runId} model=${model}`);

      const progress = await waitForCompletion(runId, session, model, abortSignal);
      if (abortSignal?.aborted) {
        await requestStop();
        throwCancelled({ model, runId, abortSignal });
      }
      if (progress.status === 'failed') {
        throw localError({ model, runId, message: remoteMessage(progress, progress.error || 'generation failed') });
      }
      if (progress.status === 'stopped') {
        if (stopRequested || abortSignal?.aborted) throwCancelled({ model, runId, abortSignal });
        throw localError({
          model,
          runId,
          message: `remote run stopped before an image was ready (${progress.stop_reason || 'no stop_reason'})`,
        });
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
        settings: {
          output, size, steps, mode: 'text_to_image', externalRunId: runId, generationId: image.generationId, sourceUrl: image.sourceUrl,
        },
        usage: { images: 1, ...estimatedUsage(output), steps },
        measurementStatus: 'estimated',
      });
    } catch (error) {
      if (runId != null && (abortSignal?.aborted || error?.code === 'JOB_CANCELLED')) {
        await requestStop();
        throwCancelled({ model, runId, abortSignal });
      }
      throw error;
    }
  }

  return { generate, stopRun };
}

module.exports = { createLocalSafetensorsClient };
