const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageProviders } = require('../src/providers/image');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');
const {
  LOCAL_SAFETENSORS_MODEL_KEYS,
  LOCAL_SAFETENSORS_MODELS,
  LOCAL_SAFETENSORS_PROVIDER,
  encodeLocalSafetensorsSelection,
  localSafetensorsConfigured,
  localSafetensorsSelectOptionsHtml,
  parseImageProviderSelection,
} = require('../src/shared/local-safetensors');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function enabledConfig(overrides = {}) {
  return {
    env: {},
    localSafetensors: {
      enabled: true,
      baseUrl: 'http://local-safetensors.test',
      pollIntervalMs: 1,
      timeoutMs: 50,
      ...overrides,
    },
  };
}

function outputFor(model) {
  const intent = mergeMediaIntent({ modality: 'image' });
  return resolveImageOutput({ provider: LOCAL_SAFETENSORS_PROVIDER, model, intent });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('local safetensors is hidden when disabled or missing base URL', () => {
  assert.equal(localSafetensorsConfigured({ localSafetensors: { enabled: false, baseUrl: 'http://x' } }), false);
  assert.equal(localSafetensorsConfigured({ localSafetensors: { enabled: true, baseUrl: '' } }), false);
  assert.equal(localSafetensorsConfigured(enabledConfig()), true);
  assert.equal(localSafetensorsSelectOptionsHtml().includes('local-safetensors:biglove-xl1'), true);
  assert.equal(localSafetensorsSelectOptionsHtml().includes('flux-dev'), false);
});

test('ready local safetensors models are registered', () => {
  assert.deepEqual(LOCAL_SAFETENSORS_MODEL_KEYS, [
    'realistic-stock-photo',
    'biglove-xl1',
  ]);
  assert.equal(LOCAL_SAFETENSORS_MODELS[0].label, 'Realistic Stock Photo v2.0');
  assert.equal(encodeLocalSafetensorsSelection('biglove-xl1'), 'local-safetensors:biglove-xl1');
  assert.deepEqual(
    parseImageProviderSelection('local-safetensors:biglove-xl1'),
    { provider: 'local-safetensors', model: 'biglove-xl1' },
  );
});

test('start request mapping, progress polling, image import, and no provider fallback', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (href.endsWith('/api/generation-runs/start')) {
      assert.equal(calls[0].body.config.model, 'biglove-xl1');
      assert.equal(calls[0].body.config.count, 1);
      assert.equal(calls[0].body.config.templates[0].text, 'A red circle');
      assert.ok(calls[0].body.client_id);
      assert.ok(calls[0].body.owner_tab_id);
      return jsonResponse({ runId: 77, targetCount: 1 });
    }
    if (href.includes('/heartbeat')) return jsonResponse({ ok: true });
    if (href.includes('/progress')) {
      if (calls.filter((call) => call.href.includes('/progress')).length < 2) {
        return jsonResponse({ runId: 77, status: 'running', completed_count: 0 });
      }
      return jsonResponse({ runId: 77, status: 'completed', completed_count: 1 });
    }
    if (href.includes('/api/generations?')) {
      return jsonResponse({
        items: [{
          id: 9,
          generation_run_id: 77,
          status: 'success',
          web_path: '/images/2026-07-25/000009_seed1.png',
          mime_type: 'image/png',
          output_path: 'C:\\projects\\safetensors-image-generator\\outputs\\secret.png',
        }],
      });
    }
    if (href.endsWith('/images/2026-07-25/000009_seed1.png')) {
      return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  try {
    const providers = createImageProviders(enabledConfig());
    const result = await providers.generate({
      provider: LOCAL_SAFETENSORS_PROVIDER,
      model: 'biglove-xl1',
      prompt: 'A red circle',
      references: [],
      output: outputFor('biglove-xl1'),
    });
    assert.equal(result.provider, LOCAL_SAFETENSORS_PROVIDER);
    assert.equal(result.model, 'biglove-xl1');
    assert.equal(result.providerRequestId, '77');
    assert.ok(Buffer.compare(result.output.buffer, PNG_BYTES) === 0);
    assert.equal(calls.some((call) => String(call.body?.config?.model || '').includes('gemini')), false);
    assert.equal(calls.some((call) => call.href.includes('output_path') || JSON.stringify(call).includes('C:\\\\')), false);
    assert.ok(calls.some((call) => call.href.includes('/api/generations?')));
    assert.ok(calls.some((call) => call.href.endsWith('/images/2026-07-25/000009_seed1.png')));
  } finally {
    global.fetch = original;
  }
});

test('remote failure normalization includes provider model and run context', async () => {
  const original = global.fetch;
  global.fetch = async () => jsonResponse({ detail: 'GPU overheating' }, 500);
  try {
    const providers = createImageProviders(enabledConfig());
    await assert.rejects(
      () => providers.generate({
        provider: LOCAL_SAFETENSORS_PROVIDER,
        model: 'biglove-xl1',
        prompt: 'x',
        output: outputFor('biglove-xl1'),
      }),
      (error) => {
        assert.match(error.message, /provider=local-safetensors/);
        assert.match(error.message, /model=biglove-xl1/);
        assert.match(error.message, /GPU overheating/);
        assert.equal(error.code, 'PROVIDER_ERROR');
        return true;
      },
    );
  } finally {
    global.fetch = original;
  }
});

test('timeout stops the remote run', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || 'GET' });
    if (href.endsWith('/start')) return jsonResponse({ runId: 12 });
    if (href.includes('/heartbeat')) return jsonResponse({ ok: true });
    if (href.includes('/progress')) return jsonResponse({ runId: 12, status: 'running', completed_count: 0 });
    if (href.includes('/stop')) return jsonResponse({ ok: true, stopping: true });
    throw new Error(`unexpected ${href}`);
  };
  try {
    const providers = createImageProviders(enabledConfig({ timeoutMs: 20, pollIntervalMs: 5 }));
    await assert.rejects(
      () => providers.generate({
        provider: 'local-safetensors:realistic-stock-photo',
        prompt: 'x',
        output: outputFor('realistic-stock-photo'),
      }),
      /timed out/,
    );
    assert.ok(calls.some((call) => call.href.includes('/stop') && call.method === 'POST'));
  } finally {
    global.fetch = original;
  }
});

test('cancellation delegates to /stop when a run id exists', async () => {
  const calls = [];
  const { AppError } = require('../src/errors');
  const controller = new AbortController();
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || 'GET' });
    if (href.endsWith('/start')) {
      queueMicrotask(() => controller.abort(new AppError('JOB_CANCELLED', 'Generation job cancelled', { status: 409 })));
      return jsonResponse({ runId: 55 });
    }
    if (href.includes('/heartbeat')) return jsonResponse({ ok: true });
    if (href.includes('/progress')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options.signal?.aborted) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      return jsonResponse({ runId: 55, status: 'running', completed_count: 0 });
    }
    if (href.includes('/stop')) return jsonResponse({ ok: true, stopping: true });
    throw new Error(`unexpected ${href}`);
  };
  try {
    const providers = createImageProviders(
      enabledConfig({ timeoutMs: 5_000, pollIntervalMs: 5 }),
      {},
      () => controller.signal,
    );
    await assert.rejects(
      () => providers.generate({
        provider: LOCAL_SAFETENSORS_PROVIDER,
        model: 'realistic-stock-photo',
        prompt: 'x',
        output: outputFor('realistic-stock-photo'),
      }),
      (error) => error.code === 'JOB_CANCELLED',
    );
    assert.ok(calls.some((call) => call.href.endsWith('/api/generation-runs/55/stop')));
    assert.equal(calls.some((call) => call.href.includes('/images/')), false);
  } finally {
    global.fetch = original;
  }
});

test('rejects non-fetchable remote image paths', async () => {
  const original = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/start')) return jsonResponse({ runId: 3 });
    if (href.includes('/heartbeat')) return jsonResponse({ ok: true });
    if (href.includes('/progress')) return jsonResponse({ runId: 3, status: 'completed', completed_count: 1 });
    if (href.includes('/api/generations?')) {
      return jsonResponse({
        items: [{ id: 1, status: 'success', web_path: 'C:\\\\projects\\\\outputs\\\\x.png', mime_type: 'image/png' }],
      });
    }
    throw new Error(`unexpected ${href}`);
  };
  try {
    const providers = createImageProviders(enabledConfig());
    await assert.rejects(
      () => providers.generate({
        provider: LOCAL_SAFETENSORS_PROVIDER,
        model: 'biglove-xl1',
        prompt: 'x',
        output: outputFor('biglove-xl1'),
      }),
      /relative web path/,
    );
  } finally {
    global.fetch = original;
  }
});

test('remote stopped run becomes a provider error, not a silent hang/cancel', async () => {
  const original = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/start')) return jsonResponse({ runId: 7 });
    if (href.includes('/heartbeat')) return jsonResponse({ ok: true });
    if (href.includes('/progress')) {
      return jsonResponse({
        runId: 7,
        status: 'stopped',
        completed_count: 0,
        stop_reason: 'recovered stale run',
      });
    }
    throw new Error(`unexpected ${href}`);
  };
  try {
    const providers = createImageProviders(enabledConfig());
    await assert.rejects(
      () => providers.generate({
        provider: LOCAL_SAFETENSORS_PROVIDER,
        model: 'biglove-xl1',
        prompt: 'x',
        output: outputFor('biglove-xl1'),
      }),
      (error) => error.code === 'PROVIDER_ERROR' && /recovered stale run/.test(error.message),
    );
  } finally {
    global.fetch = original;
  }
});

test('transient progress failures retry until completion', async () => {
  let progressAttempts = 0;
  const original = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/start')) return jsonResponse({ runId: 8 });
    if (href.includes('/heartbeat')) return jsonResponse({ ok: true });
    if (href.includes('/progress')) {
      progressAttempts += 1;
      if (progressAttempts === 1) {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return jsonResponse({ runId: 8, status: 'completed', completed_count: 1 });
    }
    if (href.includes('/api/generations?')) {
      return jsonResponse({
        items: [{ id: 1, status: 'success', web_path: '/images/ok.png', mime_type: 'image/png' }],
      });
    }
    if (href.endsWith('/images/ok.png')) {
      return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    throw new Error(`unexpected ${href}`);
  };
  try {
    const providers = createImageProviders(enabledConfig({ pollIntervalMs: 1, timeoutMs: 5_000 }));
    const result = await providers.generate({
      provider: LOCAL_SAFETENSORS_PROVIDER,
      model: 'realistic-stock-photo',
      prompt: 'x',
      output: outputFor('realistic-stock-photo'),
    });
    assert.equal(result.providerRequestId, '8');
    assert.ok(progressAttempts >= 2);
  } finally {
    global.fetch = original;
  }
});

test('disabled local safetensors does not fall back to another provider', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('should not fetch');
  };
  try {
    const providers = createImageProviders({ env: {}, localSafetensors: { enabled: false, baseUrl: '', pollIntervalMs: 1, timeoutMs: 50 } });
    await assert.rejects(
      () => providers.generate({
        provider: LOCAL_SAFETENSORS_PROVIDER,
        model: 'biglove-xl1',
        prompt: 'x',
        output: outputFor('biglove-xl1'),
      }),
      /not enabled/,
    );
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = original;
  }
});
