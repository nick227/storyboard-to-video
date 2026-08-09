const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMiniMaxH3Adapter } = require('../src/providers/video/minimax-h3');
const { videoProviderCapabilities } = require('../src/shared/video-provider-capabilities');
const { mergeMediaIntent, resolveVideoOutput } = require('../src/shared/media-output-policy');

function outputSelection(mode = 'image_to_video', resolutionTier = 'draft', durationSeconds = 5) {
  return resolveVideoOutput({
    provider: 'minimax-h3',
    model: 'minimax-h3-fl2va',
    mode,
    intent: mergeMediaIntent({
      modality: 'video',
      override: { aspectRatio: '16:9', video: { resolutionTier, durationSeconds } },
    }),
  });
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-test-'));
  const startFrame = path.join(root, 'start.png');
  const endFrame = path.join(root, 'end.png');
  fs.writeFileSync(startFrame, pngHeader(1280, 720));
  fs.writeFileSync(endFrame, pngHeader(1280, 720));
  const shared = path.join(root, 'shared');
  fs.mkdirSync(shared);
  return {
    root,
    shared,
    startFrame,
    endFrame,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('minimax-h3 capabilities expose I2V and first/last-frame with native audio', () => {
  const i2v = videoProviderCapabilities('minimax-h3', 'minimax-h3-fl2va', 'image_to_video');
  assert.equal(i2v.execution, 'synchronous');
  assert.equal(i2v.supportsNativeAudio, true);
  assert.equal(i2v.supportsEndFrame, false);

  const flf = videoProviderCapabilities('minimax-h3', 'minimax-h3-fl2va', 'first_last_frame');
  assert.equal(flf.supportsEndFrame, true);
  assert.equal(flf.supportsNativeAudio, true);
});

test('minimax-h3 output policy caps duration and resolution tiers', () => {
  const draft = outputSelection('image_to_video', 'draft', 5);
  assert.equal(draft.resolved.providerSettings.height, 480);
  assert.ok(draft.resolved.providerSettings.width % 32 === 0);

  assert.throws(
    () => resolveVideoOutput({
      provider: 'minimax-h3',
      model: 'minimax-h3-fl2va',
      mode: 'image_to_video',
      intent: mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'draft', durationSeconds: 12 } } }),
    }),
    (error) => error.code === 'UNSUPPORTED_MEDIA_OUTPUT',
  );
});

test('MiniMax H3 adapter stages shared assets and posts generate payload', async () => {
  const f = fixture();
  try {
    let sentBody = null;
    const mockFetch = async (url, options) => {
      if (String(url).endsWith('/ready')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      sentBody = JSON.parse(options.body);
      fs.writeFileSync(sentBody.output, Buffer.from('fake-mp4'));
      return new Response(JSON.stringify({
        ok: true,
        prompt_id: 'p-1',
        usage: { frames: 124, frameRate: 24, seconds: 124 / 24, steps: 20 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const adapter = createMiniMaxH3Adapter({
      env: {},
      h3Url: 'http://h3.test',
      paths: { h3Shared: f.shared },
      fetch: mockFetch,
    });

    const prepared = await adapter.prepareAssets({
      prompt: 'gentle pan',
      outputPath: path.join(f.root, 'out.mp4'),
      outputSelection: outputSelection(),
      inputPlan: {
        included: [
          { role: 'start_frame', assetPath: f.startFrame },
          { role: 'end_frame', assetPath: f.endFrame },
        ],
        output: { seed: 9 },
      },
      motionIntensity: 'medium',
    }, {
      prepareInput: async (input) => ({ ...input, transport: { path: input.assetPath } }),
      prepareOutput: async (request) => ({ path: request.outputPath }),
    });

    const task = await adapter.submit(prepared);
    assert.equal(task.state, 'completed');
    assert.equal(task.provider, 'minimax-h3');
    assert.equal(sentBody.image, prepared.stagedImage);
    assert.equal(sentBody.end_image, prepared.stagedEndImage);
    assert.equal(sentBody.seed, 9);
    assert.equal(sentBody.width, prepared.outputSelection.resolved.providerSettings.width);
    assert.ok(fs.existsSync(path.join(f.root, 'out.mp4')));
  } finally {
    f.cleanup();
  }
});

test('MiniMax H3 adapter verify maps readiness failures', async () => {
  const adapter = createMiniMaxH3Adapter({
    env: {},
    h3Url: 'http://h3.test',
    paths: { h3Shared: os.tmpdir() },
    fetch: async () => new Response(JSON.stringify({ detail: { code: 'NOT_READY', message: 'missing models', retryable: true } }), { status: 503 }),
  });
  await assert.rejects(adapter.verify(), (error) => {
    assert.equal(error.code, 'NOT_READY');
    return true;
  });
});
