const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createImageProviders } = require('../src/providers/image');
const { DEZGO_FLUX_MODEL, DEZGO_SD1_MODEL, dezgoModelForProvider, dezgoSteps } = require('../src/providers/image/dezgo-settings');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');
const { resolveImageReferencePlan } = require('../src/shared/image-reference-plan');

test('provider selection maps to SD vs Flux models', () => {
  assert.equal(dezgoModelForProvider('dezgo'), DEZGO_SD1_MODEL);
  assert.equal(dezgoModelForProvider('dezgo_flux'), DEZGO_FLUX_MODEL);
  assert.equal(dezgoSteps({ DEZGO_STEPS: '8' }, DEZGO_FLUX_MODEL), 8);
  assert.equal(dezgoSteps({ DEZGO_SD1_STEPS: '25' }, DEZGO_SD1_MODEL), 25);
});

test('Flux dimensions stay within Dezgo Flux limits', () => {
  const intent = mergeMediaIntent({ modality: 'image', override: { aspectRatio: '21:9' } });
  const output = resolveImageOutput({ provider: 'dezgo_flux', model: DEZGO_FLUX_MODEL, intent });
  assert.ok(output.resolved.width <= 1536);
  assert.ok(output.resolved.height <= 1536);
  assert.ok(output.resolved.width * output.resolved.height <= 2_359_296);
});

test('Dezgo Flux uses text2image_flux and never attaches references', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dezgo-flux-'));
  const reference = path.join(root, 'reference.png');
  fs.writeFileSync(reference, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(Buffer.from('png'), { status: 200, headers: { 'Content-Type': 'image/png', 'x-input-seed': '42' } });
  };
  try {
    const providers = createImageProviders({ env: { DEZGO_API_KEY: 'key', DEZGO_STEPS: '8' } }, { geminiParts: () => [] });
    const intent = mergeMediaIntent({ modality: 'image' });
    const output = resolveImageOutput({ provider: 'dezgo_flux', model: DEZGO_FLUX_MODEL, intent });
    const plan = resolveImageReferencePlan('dezgo_flux', [{ path: '/ref.png', role: 'character' }]);
    assert.equal(plan.included.length, 0);
    assert.equal(plan.excluded[0].reason, 'provider_does_not_consume_references');

    const result = await providers.generate({ provider: 'dezgo_flux', prompt: 'A red circle', references: [], output });
    assert.equal(calls[0].url, 'https://api.dezgo.com/text2image_flux');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, DEZGO_FLUX_MODEL);
    assert.equal(body.steps, 8);
    assert.equal(result.model, DEZGO_FLUX_MODEL);

    assert.throws(
      () => providers.generate({ provider: 'dezgo_flux', prompt: 'Prompt', references: [reference], output }),
      /accepts at most 0/,
    );
  } finally {
    global.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Dezgo SD uses image2image when references are present', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dezgo-sd-'));
  const reference = path.join(root, 'reference.png');
  fs.writeFileSync(reference, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(Buffer.from('png'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  try {
    const providers = createImageProviders({ env: { DEZGO_API_KEY: 'key', DEZGO_SD1_STEPS: '30' } }, { geminiParts: () => [] });
    const intent = mergeMediaIntent({ modality: 'image' });
    const output = resolveImageOutput({ provider: 'dezgo', model: DEZGO_SD1_MODEL, intent });
    const result = await providers.generate({ provider: 'dezgo', prompt: 'Prompt', references: [reference], output });
    assert.equal(calls[0].url, 'https://api.dezgo.com/image2image');
    assert.equal(result.model, DEZGO_SD1_MODEL);
    assert.equal(result.settings.steps, 30);
  } finally {
    global.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
