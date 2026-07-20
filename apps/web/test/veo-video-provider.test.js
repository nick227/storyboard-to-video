const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVeoAdapter } = require('../src/providers/video/veo');
const { videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');
const { mergeMediaIntent, resolveVideoOutput } = require('../src/shared/media-output-policy');

function outputSelection(mode = 'image_to_video') {
  return resolveVideoOutput({ provider: 'veo', model: 'veo-3.1-generate-preview', mode, intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'standard' } } }) });
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veo-test-'));
  const startFrame = path.join(root, 'start.png');
  const endFrame = path.join(root, 'end.png');
  fs.writeFileSync(startFrame, pngHeader(1280, 720));
  fs.writeFileSync(endFrame, pngHeader(1280, 720));
  return { root, startFrame, endFrame, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Veo adapter verify checks GEMINI_API_KEY configuration', async () => {
  const adapterWithoutKey = createVeoAdapter({ env: { GEMINI_API_KEY: '' } });
  await assert.rejects(adapterWithoutKey.verify(), (error) => {
    assert.equal(error.code, 'NOT_CONFIGURED');
    return true;
  });

  const adapterWithKey = createVeoAdapter({ env: { GEMINI_API_KEY: 'test-key' } });
  const result = await adapterWithKey.verify({ model: 'veo-3.1-generate-preview' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'veo');
});

test('Veo submit builds predictLongRunning payload with an initial frame only', async () => {
  const f = fixture();
  try {
    let sentUrl = '';
    let sentBody = null;
    let sentHeaders = null;
    const mockFetch = async (url, options) => {
      sentUrl = url;
      sentHeaders = options.headers;
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ name: 'operations/abc123' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const adapter = createVeoAdapter({ env: { GEMINI_API_KEY: 'test-key' }, fetch: mockFetch });
    const request = {
      model: 'veo-3.1-generate-preview',
      generationMode: 'image_to_video',
      prompt: 'A dragon flies through dramatic sunset clouds.',
      preparedInputs: [{ role: 'start_frame', assetPath: f.startFrame }],
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection('image_to_video'),
    };

    const task = await adapter.submit(request);

    assert.match(sentUrl, /\/v1beta\/models\/veo-3\.1-generate-preview:predictLongRunning$/);
    assert.equal(sentHeaders['x-goog-api-key'], 'test-key');
    assert.equal(sentBody.instances[0].prompt, 'A dragon flies through dramatic sunset clouds.');
    assert.match(sentBody.instances[0].image.inlineData.data, /^[A-Za-z0-9+/=]+$/);
    assert.equal(sentBody.instances[0].image.inlineData.mimeType, 'image/png');
    assert.equal(Object.hasOwn(sentBody.instances[0], 'lastFrame'), false);
    assert.deepEqual(sentBody.parameters, { aspectRatio: '16:9', resolution: '720p', durationSeconds: '6' });
    assert.equal(task.state, 'submitted');
    assert.equal(task.providerTaskId, 'operations/abc123');
  } finally { f.cleanup(); }
});

test('Veo submit requires both frames for first_last_frame mode', async () => {
  const f = fixture();
  try {
    const adapter = createVeoAdapter({ env: { GEMINI_API_KEY: 'test-key' }, fetch: async () => new Response('{}') });
    const request = {
      model: 'veo-3.1-generate-preview',
      generationMode: 'first_last_frame',
      prompt: 'Smooth motion between two keyframes.',
      preparedInputs: [{ role: 'start_frame', assetPath: f.startFrame }],
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection('first_last_frame'),
    };
    await assert.rejects(adapter.submit(request), (error) => {
      assert.equal(error.code, 'VIDEO_FRAME_REQUIRED');
      return true;
    });
  } finally { f.cleanup(); }
});

test('Veo submit sends both frames for first_last_frame mode', async () => {
  const f = fixture();
  try {
    let sentBody = null;
    const mockFetch = async (url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ name: 'operations/keyframe-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const adapter = createVeoAdapter({ env: { GEMINI_API_KEY: 'test-key' }, fetch: mockFetch });
    const request = {
      model: 'veo-3.1-generate-preview',
      generationMode: 'first_last_frame',
      prompt: 'Smooth motion between two keyframes.',
      preparedInputs: [
        { role: 'start_frame', assetPath: f.startFrame },
        { role: 'end_frame', assetPath: f.endFrame },
      ],
      outputPath: path.join(f.root, 'output.mp4'),
      outputSelection: outputSelection('first_last_frame'),
    };
    const task = await adapter.submit(request);
    assert.match(sentBody.instances[0].image.inlineData.data, /^[A-Za-z0-9+/=]+$/);
    assert.match(sentBody.instances[0].lastFrame.inlineData.data, /^[A-Za-z0-9+/=]+$/);
    assert.equal(task.providerTaskId, 'operations/keyframe-1');
  } finally { f.cleanup(); }
});

test('Veo inspect polls the long-running operation and reports running/completed/failed', async () => {
  const responses = [
    { done: false },
    { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://example.test/video.mp4' } }] } } },
  ];
  let call = 0;
  const mockFetch = async () => { const body = responses[call]; call += 1; return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const adapter = createVeoAdapter({ env: { GEMINI_API_KEY: 'test-key' }, fetch: mockFetch });

  const running = await adapter.inspect({ providerTaskId: 'operations/abc123' });
  assert.equal(running.state, 'running');

  const completed = await adapter.inspect({ providerTaskId: 'operations/abc123' });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.remoteUrl, 'https://example.test/video.mp4');

  const failingFetch = async () => new Response(JSON.stringify({ done: true, error: { message: 'quota exceeded' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const failingAdapter = createVeoAdapter({ env: { GEMINI_API_KEY: 'test-key' }, fetch: failingFetch });
  const failed = await failingAdapter.inspect({ providerTaskId: 'operations/abc123' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'VEO_TASK_FAILED');
});

test('Veo capabilities: start-only vs start+end are distinct modes on the same model', () => {
  const startOnly = videoProviderCapabilities('veo', 'veo-3.1-generate-preview', 'image_to_video');
  assert.equal(startOnly.supportsStartFrame, true);
  assert.equal(startOnly.supportsEndFrame, false);

  const startEnd = videoProviderCapabilities('veo', 'veo-3.1-generate-preview', 'first_last_frame');
  assert.equal(startEnd.supportsStartFrame, true);
  assert.equal(startEnd.supportsEndFrame, true);
  assert.equal(startEnd.maxInputs, 2);
});
