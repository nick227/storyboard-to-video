const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMiniMaxAdapter } = require('../src/providers/video/minimax');
const { createLocalVideoAssetTransport } = require('../src/providers/video/asset-transport');
const { videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');
const { mergeMediaIntent, resolveVideoOutput } = require('../src/shared/media-output-policy');
const { validateMiniMaxInterpolationFrames } = require('../src/services/video-generation.service');

function outputSelection(model = 'MiniMax-Hailuo-02', mode = 'image_to_video') {
  return resolveVideoOutput({ provider: 'minimax', model, mode, intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'standard', durationSeconds: 6 } } }) });
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-test-'));
  const startFrame = path.join(root, 'start.png');
  const endFrame = path.join(root, 'end.png');
  fs.writeFileSync(startFrame, pngHeader(1280, 720));
  fs.writeFileSync(endFrame, pngHeader(1920, 1080));
  return {
    root,
    startFrame,
    endFrame,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('MiniMax adapter verify checks API key configuration', async () => {
  const adapterWithoutKey = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: '' } });
  await assert.rejects(adapterWithoutKey.verify(), (error) => {
    assert.equal(error.code, 'NOT_CONFIGURED');
    return true;
  });

  const adapterWithKey = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' } });
  const result = await adapterWithKey.verify({ model: 'video-01' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'minimax');
});

test('MiniMax submit task constructs correct JSON payload with base64 image', async () => {
  const f = fixture();
  try {
    let sentUrl = '';
    let sentBody = null;

    const mockFetch = async (url, options) => {
      sentUrl = url;
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ task_id: 'task-12345', base_resp: { status_code: 0, status_msg: 'success' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' }, fetch: mockFetch });

    const request = {
      model: 'video-01',
      prompt: 'A dragon flies through dramatic sunset clouds.',
      preparedInputs: [{ role: 'start_frame', assetPath: f.startFrame }],
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection(),
    };

    const task = await adapter.submit(request);

    assert.match(sentUrl, /\/v1\/video_generation$/);
    assert.equal(sentBody.model, 'video-01');
    assert.equal(sentBody.prompt, 'A dragon flies through dramatic sunset clouds.');
    assert.match(sentBody.first_frame_image, /^data:image\/png;base64,/);
    assert.equal(task.providerTaskId, 'task-12345');
    assert.equal(task.state, 'submitted');
  } finally {
    f.cleanup();
  }
});

test('MiniMax retries provider rate-limit code 1002 before accepting a video task', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const delays = [];
    const mockFetch = async () => {
      calls++;
      if (calls < 3) {
        return new Response(JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ task_id: 'task-after-throttle', base_resp: { status_code: 0, status_msg: 'success' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const adapter = createMiniMaxAdapter({
      env: { MINIMAX_API_KEY: 'test-key', MINIMAX_RATE_LIMIT_RETRY_MS: '25' },
      fetch: mockFetch,
      sleep: async (delayMs) => delays.push(delayMs),
    });

    const task = await adapter.submit({
      model: 'MiniMax-Hailuo-02',
      prompt: 'A ship crosses a stormy sea.',
      preparedInputs: [{ role: 'start_frame', assetPath: f.startFrame }],
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection(),
    });

    assert.equal(task.providerTaskId, 'task-after-throttle');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [25, 50]);
  } finally {
    f.cleanup();
  }
});

test('MiniMax exposes exhausted provider rate limits as retryable HTTP 429 errors', async () => {
  const f = fixture();
  try {
    const mockFetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const adapter = createMiniMaxAdapter({
      env: { MINIMAX_API_KEY: 'test-key', MINIMAX_RATE_LIMIT_MAX_ATTEMPTS: '1' },
      fetch: mockFetch,
    });

    await assert.rejects(adapter.submit({
      model: 'MiniMax-Hailuo-02',
      prompt: 'A ship crosses a stormy sea.',
      preparedInputs: [{ role: 'start_frame', assetPath: f.startFrame }],
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection(),
    }), (error) => {
      assert.equal(error.code, 'MINIMAX_RATE_LIMITED');
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryable, true);
      return true;
    });
  } finally {
    f.cleanup();
  }
});

// Regression test: video-execution.service.js's real create() calls prepareAssets(request,
// assetTransport) with the actual shared createLocalVideoAssetTransport() (dependencies.js has no
// override), not with bare { assetPath } items as the tests above use. That transport's
// prepareInput() attaches `transport: { type: 'local_file', path }` -- a path on this server's own
// disk, meaningless to MiniMax's remote API. Submitting that path directly produced the real,
// live "MiniMax API error (2013): invalid params, first_frame_image: invalid image url". Every
// prior test here bypassed this because none of them ran prepareAssets() with the real transport.
test('MiniMax submit base64-encodes the frame even when routed through the real local asset transport', async () => {
  const f = fixture();
  try {
    let sentBody = null;
    const mockFetch = async (url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ task_id: 'task-local-transport', base_resp: { status_code: 0, status_msg: 'success' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const adapter = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' }, fetch: mockFetch });
    const transport = createLocalVideoAssetTransport();

    const request = {
      model: 'MiniMax-Hailuo-02',
      generationMode: 'first_last_frame',
      prompt: 'Smooth motion between two keyframes.',
      inputPlan: { included: [
        { role: 'start_frame', assetPath: f.startFrame, sourcePath: f.startFrame },
        { role: 'end_frame', assetPath: f.endFrame, sourcePath: f.endFrame },
      ] },
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection('MiniMax-Hailuo-02', 'first_last_frame'),
    };

    const prepared = await adapter.prepareAssets(request, transport);
    // Prove the bug condition is actually present in this test: the real transport really does
    // hand back a bare local path, not a URL -- otherwise this test would pass for the wrong reason.
    assert.equal(prepared.preparedInputs[0].transport.type, 'local_file');
    assert.equal(prepared.preparedInputs[0].transport.path, f.startFrame);
    assert.equal(prepared.preparedInputs[0].transport.url, undefined);

    await adapter.submit(prepared);

    assert.match(sentBody.first_frame_image, /^data:image\/png;base64,/, `first_frame_image must be base64 image data, not a local path like ${f.startFrame}`);
    assert.match(sentBody.last_frame_image, /^data:image\/png;base64,/, `last_frame_image must be base64 image data, not a local path like ${f.endFrame}`);
  } finally {
    f.cleanup();
  }
});

test('MiniMax submit task handles documented Hailuo first/last-frame mode', async () => {
  const f = fixture();
  try {
    let sentBody = null;
    const mockFetch = async (url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ task_id: 'task-keyframe-999', base_resp: { status_code: 0, status_msg: 'success' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' }, fetch: mockFetch });
    const request = {
      model: 'MiniMax-Hailuo-02',
      generationMode: 'first_last_frame',
      prompt: 'Smooth camera shift between two keyframes.',
      preparedInputs: [
        { role: 'start_frame', assetPath: f.startFrame },
        { role: 'end_frame', assetPath: f.endFrame },
      ],
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection('MiniMax-Hailuo-02', 'first_last_frame'),
    };

    const task = await adapter.submit(request);

    assert.equal(task.providerTaskId, 'task-keyframe-999');
    assert.equal(sentBody.model, 'MiniMax-Hailuo-02');
    assert.equal(sentBody.resolution, '768P');
    assert.equal(sentBody.duration, 6);
    assert.match(sentBody.first_frame_image, /^data:image\/png;base64,/);
    assert.match(sentBody.last_frame_image, /^data:image\/png;base64,/);
  } finally {
    f.cleanup();
  }
});

test('MiniMax inspect transitions task state between running, completed, and failed', async () => {
  let callCount = 0;
  const mockFetch = async (url) => {
    callCount++;
    assert.match(url, /task_id=task-12345/);
    if (callCount === 1) {
      return new Response(JSON.stringify({ status: 'Processing', base_resp: { status_code: 0 } }), { status: 200 });
    }
    if (callCount === 2) {
      return new Response(
        JSON.stringify({
          status: 'Success',
          file_id: 'file-998877',
          download_url: 'http://example.com/video-result.mp4',
          base_resp: { status_code: 0 },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ status: 'Fail', base_resp: { status_code: 500, status_msg: 'GPU allocation failed' } }), { status: 200 });
  };

  const adapter = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' }, fetch: mockFetch });
  const initialTask = { providerTaskId: 'task-12345', state: 'submitted' };

  const runningTask = await adapter.inspect(initialTask);
  assert.equal(runningTask.state, 'running');
  assert.ok(runningTask.pollAfter);

  const completedTask = await adapter.inspect(runningTask);
  assert.equal(completedTask.state, 'completed');
  assert.equal(completedTask.providerOutputId, 'file-998877');
  assert.equal(completedTask.remoteUrl, 'http://example.com/video-result.mp4');

  const failedTask = await adapter.inspect(initialTask);
  assert.equal(failedTask.state, 'failed');
  assert.match(failedTask.error.message, /GPU allocation failed/);
});

test('MiniMax handles API errors and malformed JSON responses', async () => {
  const mockFetchError = async () => new Response('Internal Gateway Error', { status: 502 });
  const adapter = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' }, fetch: mockFetchError });

  await assert.rejects(
    adapter.submit({ prompt: 'Test prompt', outputSelection: outputSelection() }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_ERROR');
      return true;
    }
  );

  const mockMalformed = async () => new Response(JSON.stringify({ base_resp: { status_code: 1001, status_msg: 'Invalid parameter' } }), { status: 200 });
  const adapterMalformed = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' }, fetch: mockMalformed });

  await assert.rejects(
    adapterMalformed.submit({ prompt: 'Test prompt', outputSelection: outputSelection() }),
    (error) => {
      assert.equal(error.code, 'MINIMAX_ERROR');
      return true;
    }
  );
});

test('MiniMax fetchResult retrieves download URL if missing and streams output file', async () => {
  const f = fixture();
  try {
    const fakeMp4 = Buffer.from('MINIMAX-GENERATED-VIDEO-STREAM');
    const mockFetch = async (url) => {
      if (url.includes('/files/retrieve')) {
        return new Response(JSON.stringify({ download_url: 'http://example.com/streamed-video.mp4' }), { status: 200 });
      }
      if (url.includes('streamed-video.mp4')) {
        return new Response(fakeMp4, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(fakeMp4.length) } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const adapter = createMiniMaxAdapter({ env: { MINIMAX_API_KEY: 'test-key' }, fetch: mockFetch });
    const targetPath = path.join(f.root, 'final-result.mp4');

    const task = {
      providerTaskId: 'task-555',
      providerOutputId: 'file-abc-123',
      requestSnapshot: { outputPath: targetPath },
    };

    const result = await adapter.fetchResult(task);

    assert.equal(result.provider, 'minimax');
    assert.equal(result.output.outputPath, targetPath);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'MINIMAX-GENERATED-VIDEO-STREAM');
  } finally {
    f.cleanup();
  }
});

test('MiniMax provider model capability differences are enforced in capabilities resolution', () => {
  const capsV1 = videoProviderCapabilities('minimax', 'video-01', 'image_to_video');
  assert.equal(capsV1.supportsStartFrame, true);
  assert.equal(capsV1.supportsEndFrame, false);
  assert.equal(capsV1.maxInputs, 1);

  const capsKeyframe = videoProviderCapabilities('minimax', 'MiniMax-Hailuo-02', 'first_last_frame');
  assert.equal(capsKeyframe.supportsStartFrame, true);
  assert.equal(capsKeyframe.supportsEndFrame, true);
  assert.equal(capsKeyframe.maxInputs, 2);

  assert.throws(() => videoProviderCapabilities('minimax', 'video-01', 'first_last_frame'), /does not implement video mode: first_last_frame/);
});

test('MiniMax interpolation validates frame dimensions and rejects provider-side cropping', () => {
  const f = fixture();
  try {
    assert.deepEqual(validateMiniMaxInterpolationFrames(f.startFrame, f.endFrame, '16:9').start, { width: 1280, height: 720, format: 'png' });
    fs.writeFileSync(f.endFrame, pngHeader(1024, 768));
    assert.throws(() => validateMiniMaxInterpolationFrames(f.startFrame, f.endFrame, '16:9'), (error) => error.code === 'VIDEO_FRAME_ASPECT_MISMATCH');
  } finally { f.cleanup(); }
});
