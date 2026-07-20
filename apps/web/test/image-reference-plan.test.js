const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  IMAGE_PROVIDER_CAPABILITIES,
  imageProviderCapabilities,
  resolveImageReferencePlan,
} = require('../src/shared/image-reference-plan');
const { createImageProviders } = require('../src/providers/image');

function references(count) {
  const roles = ['character', 'location', 'composition', 'continuity'];
  return Array.from({ length: count }, (_, index) => ({
    path: `/reference-${index}.png`,
    localPath: `/tmp/reference-${index}.png`,
    source: index < 2 ? 'scene' : 'style',
    role: roles[index % roles.length],
  }));
}

test('image providers publish explicit reference capabilities', () => {
  assert.deepEqual(Object.keys(IMAGE_PROVIDER_CAPABILITIES).sort(), ['dezgo', 'gemini', 'openai', 'stub']);
  assert.equal(imageProviderCapabilities('gemini').maxReferences, 14);
  assert.equal(imageProviderCapabilities('openai').maxReferences, 8);
  assert.equal(imageProviderCapabilities('dezgo').transport, 'image_to_image_anchor');
  assert.equal(imageProviderCapabilities('stub').consumesReferences, false);
  assert.throws(() => imageProviderCapabilities('unknown'), /Unsupported image provider/);
});

test('reference planning preserves candidate priority and makes provider omissions explicit', () => {
  const plan = resolveImageReferencePlan('dezgo', references(3));
  assert.equal(plan.included.length, 1);
  assert.equal(plan.included[0].path, '/reference-0.png');
  assert.equal(plan.included[0].providerSlot, 'init_image');
  assert.deepEqual(plan.excluded.map((item) => item.reason), ['provider_limit', 'provider_limit']);
  assert.deepEqual(plan.excluded.map((item) => item.candidateOrder), [1, 2]);
});

test('Gemini and OpenAI clamp through the neutral planner while stub records non-consumption', () => {
  const candidates = references(16);
  const gemini = resolveImageReferencePlan('gemini', candidates);
  const openai = resolveImageReferencePlan('openai', candidates);
  const stub = resolveImageReferencePlan('stub', candidates.slice(0, 2));

  assert.equal(gemini.included.length, 14);
  assert.equal(gemini.excluded.length, 2);
  assert.equal(gemini.included[13].providerSlot, 'contents.parts.reference[13]');
  assert.equal(openai.included.length, 8);
  assert.equal(openai.included[7].providerSlot, 'image[7]');
  assert.deepEqual(stub.included, []);
  assert.deepEqual(stub.excluded.map((item) => item.reason), ['provider_does_not_consume_references', 'provider_does_not_consume_references']);
});

test('browser and server reference planners produce the same manifest-facing plan', async () => {
  const browser = await import(path.join(__dirname, '..', 'public', 'modules', 'image-reference-plan.js'));
  const candidates = references(10).map(({ localPath, ...reference }) => reference);
  for (const provider of ['gemini', 'openai', 'dezgo', 'stub']) {
    assert.deepEqual(browser.resolveImageReferencePlan(provider, candidates), resolveImageReferencePlan(provider, candidates));
  }
});

test('provider adapters reject unplanned overflow instead of silently slicing', () => {
  const providers = createImageProviders({ env: {} }, { geminiParts: () => [] });
  assert.throws(
    () => providers.generate({ provider: 'dezgo', prompt: 'Prompt', references: ['/one.png', '/two.png'] }),
    /at most 1 planned reference image/,
  );
});
