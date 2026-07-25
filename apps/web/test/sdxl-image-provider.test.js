const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageProviders } = require('../src/providers/image');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');
const { resolveImageReferencePlan } = require('../src/shared/image-reference-plan');

test('SDXL resolves standard 1024 short-edge dimensions', () => {
  const intent = mergeMediaIntent({ modality: 'image', override: { aspectRatio: '16:9' } });
  const output = resolveImageOutput({ provider: 'sdxl', model: 'sdxl-base-1.0', intent });
  assert.equal(output.resolved.height, 1024);
  assert.equal(output.resolved.width, 1824);
  assert.equal(output.resolved.providerSettings.steps, 30);
  assert.equal(output.resolved.providerSettings.guidance, 5);
});

test('SDXL provider posts to IMAGE_SERVICE_URL and returns PNG bytes', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  };
  try {
    const providers = createImageProviders({
      imageServiceUrl: 'https://image-service.example.modal.run',
      imageServiceToken: 'secret',
      env: {},
    }, { geminiParts: () => [] });
    const intent = mergeMediaIntent({ modality: 'image' });
    const output = resolveImageOutput({ provider: 'sdxl', model: 'sdxl-base-1.0', intent });
    const plan = resolveImageReferencePlan('sdxl', [{ path: '/ref.png', role: 'character' }]);
    assert.equal(plan.included.length, 0);

    const result = await providers.generate({ provider: 'sdxl', prompt: 'A red circle', references: [], output });
    assert.equal(calls[0].url, 'https://image-service.example.modal.run/generate');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.prompt, 'A red circle');
    assert.equal(body.width, output.resolved.width);
    assert.equal(body.height, output.resolved.height);
    assert.equal(result.provider, 'sdxl');
    assert.equal(result.model, 'sdxl-base-1.0');
    assert.equal(result.output.extension, 'png');
  } finally {
    global.fetch = original;
  }
});

test('SDXL requires IMAGE_SERVICE_URL', async () => {
  const providers = createImageProviders({ env: {} }, { geminiParts: () => [] });
  const intent = mergeMediaIntent({ modality: 'image' });
  const output = resolveImageOutput({ provider: 'sdxl', model: 'sdxl-base-1.0', intent });
  await assert.rejects(
    () => providers.generate({ provider: 'sdxl', prompt: 'hi', references: [], output }),
    /IMAGE_SERVICE_URL/,
  );
});
