const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createImageProviders } = require('../src/providers/image');
const { DEZGO_FLUX_MODEL, dezgoModel, dezgoSteps, isDezgoFlux } = require('../src/providers/image/dezgo-settings');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');

test('dezgo defaults to Flux Schnell with quality steps', () => {
  assert.equal(dezgoModel({}), DEZGO_FLUX_MODEL);
  assert.equal(isDezgoFlux(DEZGO_FLUX_MODEL), true);
  assert.equal(dezgoSteps({}, DEZGO_FLUX_MODEL), 8);
  assert.equal(dezgoSteps({ DEZGO_STEPS: '12' }, DEZGO_FLUX_MODEL), 12);
});

test('Flux dimensions stay within Dezgo Flux limits', () => {
  const intent = mergeMediaIntent({ modality: 'image', override: { aspectRatio: '21:9' } });
  const output = resolveImageOutput({ provider: 'dezgo', model: DEZGO_FLUX_MODEL, intent });
  assert.ok(output.resolved.width <= 1536);
  assert.ok(output.resolved.height <= 1536);
  assert.ok(output.resolved.width * output.resolved.height <= 2_359_296);
  assert.equal(output.resolved.width % 8, 0);
  assert.equal(output.resolved.height % 8, 0);
});

test('Dezgo text generation uses text2image_flux with Flux settings', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(Buffer.from('png'), { status: 200, headers: { 'Content-Type': 'image/png', 'x-input-seed': '42' } });
  };
  try {
    const providers = createImageProviders({ env: { DEZGO_API_KEY: 'key' } }, { geminiParts: () => [] });
    const intent = mergeMediaIntent({ modality: 'image' });
    const output = resolveImageOutput({ provider: 'dezgo', model: DEZGO_FLUX_MODEL, intent });
    const result = await providers.generate({ provider: 'dezgo', prompt: 'A red circle', references: [], output });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.dezgo.com/text2image_flux');
    assert.match(calls[0].options.headers['Content-Type'], /application\/json/);
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, {
      prompt: 'A red circle',
      model: DEZGO_FLUX_MODEL,
      width: output.resolved.width,
      height: output.resolved.height,
      steps: 8,
      format: 'png',
    });
    assert.equal(result.model, DEZGO_FLUX_MODEL);
    assert.equal(result.settings.steps, 8);
    assert.equal(result.usage.steps, 8);
  } finally {
    global.fetch = original;
  }
});

test('Dezgo with references still uses SD1 image2image', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dezgo-flux-'));
  const reference = path.join(root, 'reference.png');
  fs.writeFileSync(reference, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(Buffer.from('png'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  try {
    const providers = createImageProviders({ env: { DEZGO_API_KEY: 'key', DEZGO_STEPS: '8' } }, { geminiParts: () => [] });
    const intent = mergeMediaIntent({ modality: 'image' });
    const output = resolveImageOutput({ provider: 'dezgo', model: DEZGO_FLUX_MODEL, intent });
    const result = await providers.generate({ provider: 'dezgo', prompt: 'Prompt', references: [reference], output });
    assert.equal(calls[0].url, 'https://api.dezgo.com/image2image');
    assert.equal(result.model, 'text2image');
    assert.equal(result.settings.mode, 'image_to_image');
    assert.equal(result.settings.steps, 30);
    assert.ok(result.settings.steps >= 10);
  } finally {
    global.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SD1 steps stay in range when Flux DEZGO_STEPS is configured', () => {
  assert.equal(dezgoSteps({ DEZGO_MODEL: DEZGO_FLUX_MODEL, DEZGO_STEPS: '8' }, 'text2image'), 30);
  assert.equal(dezgoSteps({ DEZGO_MODEL: DEZGO_FLUX_MODEL, DEZGO_SD1_STEPS: '25' }, 'text2image'), 25);
  assert.equal(dezgoSteps({ DEZGO_MODEL: 'text2image', DEZGO_STEPS: '8' }, 'text2image'), 10);
});
