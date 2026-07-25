#!/usr/bin/env node
/**
 * Live smoke against the Windows Safetensors service from WSL.
 * Usage: node scripts/smoke-local-safetensors.js
 */
const { createImageProviders } = require('../src/providers/image');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');
const { AppError } = require('../src/errors');
const { GenerationQueue } = require('../src/services/generation-queue');

const BASE = process.env.LOCAL_SAFETENSORS_BASE_URL || 'http://host.docker.internal:8011';

function outputFor(model) {
  return resolveImageOutput({
    provider: 'local-safetensors',
    model,
    intent: mergeMediaIntent({ modality: 'image' }),
  });
}

async function checkWebPathReachability() {
  const list = await fetch(`${BASE}/api/generations?limit=1&sort=newest`).then((r) => r.json());
  const item = list.items?.[0];
  if (!item?.web_path) throw new Error('no generation with web_path available for reachability check');
  if (!item.web_path.startsWith('/') || item.web_path.includes('localhost')) {
    throw new Error(`unexpected web_path shape: ${item.web_path}`);
  }
  if (item.output_path && /[A-Za-z]:\\/.test(item.output_path)) {
    console.log(`ok: output_path is Windows-local (${item.output_path}) and must not be used as asset source`);
  }
  const url = `${BASE}${item.web_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`web_path fetch failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`web_path download too small (${bytes.length}) from ${url}`);
  const localhost = await fetch(`http://127.0.0.1:8011${item.web_path}`).then(() => 'reachable').catch(() => 'unreachable');
  console.log(`ok: web_path fetch ${url} -> ${bytes.length} bytes; localhost control=${localhost}`);
  return { url, bytes: bytes.length };
}

async function cancelFluxRun() {
  const calls = [];
  const original = global.fetch;
  const queue = new GenerationQueue({ concurrency: 1 });
  let runId = null;
  let stopSeen = false;

  global.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || 'GET' });
    if (href.includes('/stop')) stopSeen = true;
    return original(url, options);
  };

  try {
    let signalRef;
    const job = await queue.add('image', 'smoke-local', async (signal) => {
      signalRef = signal;
      const providers = createImageProviders({
        env: {},
        localSafetensors: {
          enabled: true,
          baseUrl: BASE,
          pollIntervalMs: 1000,
          timeoutMs: 600_000,
        },
      }, {}, () => signal);
      return providers.generate({
        provider: 'local-safetensors',
        model: 'biglove-xl1',
        prompt: 'smoke cancel test: a single blue square, minimal',
        references: [],
        output: outputFor('biglove-xl1'),
      });
    });

    // Wait until the remote run is actually running, then cancel the Storyboarder job.
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const start = calls.find((c) => c.href.endsWith('/api/generation-runs/start') && c.method === 'POST');
      if (!start) continue;
      // Discover run id from progress polls.
      const progressCall = calls.find((c) => /\/api\/generation-runs\/\d+\/progress/.test(c.href));
      if (progressCall) {
        runId = Number(progressCall.href.match(/generation-runs\/(\d+)\/progress/)[1]);
        break;
      }
    }
    if (!runId) throw new Error('timed out waiting for flux start/progress before cancel');

    const cancelled = await queue.cancel(job.id);
    let thrown = null;
    try { await job.promise; } catch (error) { thrown = error; }

    // Give cooperative stop a moment, then inspect remote status.
    await new Promise((r) => setTimeout(r, 2000));
    const progress = await original(`${BASE}/api/generation-runs/${runId}/progress`).then((r) => r.json());
    const imageFetches = calls.filter((c) => c.href.includes('/images/') && !c.href.includes('/api/'));

    console.log(JSON.stringify({
      storyboarderJobStatus: cancelled.status,
      thrownCode: thrown?.code || null,
      thrownMessage: thrown?.message || null,
      stopSeen,
      remoteStatus: progress.status,
      remoteCompleted: progress.completed_count,
      imageFetches: imageFetches.length,
      signalAborted: Boolean(signalRef?.aborted),
    }, null, 2));

    if (cancelled.status !== 'cancelled') throw new Error(`expected cancelled job, got ${cancelled.status}`);
    if (!stopSeen) throw new Error('/stop was not called');
    if (!['stopped', 'stopping', 'failed', 'completed'].includes(progress.status)) {
      throw new Error(`unexpected remote status after cancel: ${progress.status}`);
    }
    if (progress.status === 'completed' && Number(progress.completed_count || 0) > 0 && imageFetches.length > 0) {
      throw new Error('cancel raced to completion and imported an image');
    }
    if (thrown && thrown.code !== 'JOB_CANCELLED' && cancelled.status === 'cancelled') {
      console.log('note: provider throw was non-JOB_CANCELLED but queue kept cancelled status');
    }
    console.log('ok: flux cancel path stopped remote work without attaching a Storyboarder asset');
  } finally {
    global.fetch = original;
  }
}

async function generateOneFastModel() {
  const providers = createImageProviders({
    env: {},
    localSafetensors: {
      enabled: true,
      baseUrl: BASE,
      pollIntervalMs: 1000,
      timeoutMs: 600_000,
    },
  });
  const result = await providers.generate({
    provider: 'local-safetensors',
    model: 'realistic-stock-photo',
    prompt: 'smoke test: a plain red apple on a white table, photorealistic',
    references: [],
    output: outputFor('realistic-stock-photo'),
  });
  if (result.provider !== 'local-safetensors') throw new Error('wrong provider');
  if (!Buffer.isBuffer(result.output.buffer) || result.output.buffer.length < 1000) {
    throw new Error('missing image bytes');
  }
  if (String(result.settings?.sourceUrl || '').includes('localhost')) {
    throw new Error('sourceUrl unexpectedly used localhost');
  }
  if (/[A-Za-z]:\\/.test(String(result.settings?.sourceUrl || ''))) {
    throw new Error('sourceUrl unexpectedly used Windows path');
  }
  console.log(`ok: generated ${result.model} -> ${result.output.buffer.length} bytes via ${result.settings.sourceUrl}`);
  return result;
}

async function main() {
  console.log(`base=${BASE}`);
  await checkWebPathReachability();
  await generateOneFastModel();
  await cancelFluxRun();
  console.log('smoke complete');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
