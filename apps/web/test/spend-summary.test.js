const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateEvents } = require('../src/services/spend-summary.service');

function flatPrice(provider, modality, model, nanoUsdPerUnit, quantityKey) {
  return { provider, modality, model, rateCard: { type: 'flat', nanoUsdPerUnit, ...(quantityKey ? { quantityKey } : {}) } };
}

test('an event with no matching price is unpriced, not silently zero-cost', () => {
  const events = [{ provider: 'minimax', modality: 'video', model: 'unknown-model', usage: { videos: 1 } }];
  const { totalCostUSD, unpriced, providers } = aggregateEvents(events, []);
  assert.equal(totalCostUSD, 0);
  assert.deepEqual(unpriced, [{ provider: 'minimax', modality: 'video', model: 'unknown-model', count: 1 }]);
  assert.equal(providers.minimax.modalities.video.models['unknown-model'].unpriced, true);
});

test('an event with a matching active price is computed live from the real rate card, not flagged unpriced', () => {
  const events = [{ provider: 'ltx', modality: 'video', model: 'ltx-video', usage: { videos: 2 } }];
  const prices = [flatPrice('ltx', 'video', 'ltx-video', 15_000_000, 'videos')];
  const { totalCostUSD, unpriced, providers } = aggregateEvents(events, prices);
  assert.equal(totalCostUSD, 0.03);
  assert.deepEqual(unpriced, []);
  assert.equal(providers.ltx.modalities.video.models['ltx-video'].unpriced, false);
});

test('a real ProviderCostSnapshot always takes precedence over a live-computed price match', () => {
  const events = [{ provider: 'openai', modality: 'text', model: 'gpt-4.1-mini', usage: {}, costSnapshot: { providerCostNanoUsd: 18_000n } }];
  const prices = [flatPrice('openai', 'text', 'gpt-4.1-mini', 999_999_999)];
  const { totalCostUSD, unpriced } = aggregateEvents(events, prices);
  assert.equal(totalCostUSD, 0.000018);
  assert.deepEqual(unpriced, []);
});

test('stub provider events are always free, never unpriced', () => {
  const events = [{ provider: 'stub', modality: 'audio', model: 'stub-audio-v1', usage: {} }];
  const { totalCostUSD, unpriced } = aggregateEvents(events, []);
  assert.equal(totalCostUSD, 0);
  assert.deepEqual(unpriced, []);
});

test('a UsageEvent stores the canonical model key (not a dated/versioned provider-returned string), so it resolves against the active price', () => {
  // Mirrors what prisma-usage.repository.js now writes: model is always the canonical
  // GenerationRequest key, with the provider's raw returned string preserved separately.
  const events = [{ provider: 'openai', modality: 'text', model: 'gpt-4.1-mini', providerModel: 'gpt-4.1-mini-2025-04-14', usage: { inputTokens: 13, cachedInputTokens: 0, outputTokens: 3 } }];
  const prices = [{ provider: 'openai', modality: 'text', model: 'gpt-4.1-mini', rateCard: { type: 'token_components', components: [
    { usageKey: 'inputTokens', subtractUsageKey: 'cachedInputTokens', nanoUsdPerMillion: 400_000_000 },
    { usageKey: 'cachedInputTokens', nanoUsdPerMillion: 100_000_000 },
    { usageKey: 'outputTokens', nanoUsdPerMillion: 1_600_000_000 },
  ] } }];
  const { unpriced, totalCostUSD, providers } = aggregateEvents(events, prices);
  assert.deepEqual(unpriced, []);
  assert.ok(totalCostUSD > 0);
  assert.equal(providers.openai.modalities.text.models['gpt-4.1-mini'].unpriced, false);
  assert.equal(providers.openai.modalities.text.models['gpt-4.1-mini-2025-04-14'], undefined);
});

test('unpriced events across multiple providers are each reported with their own count', () => {
  const events = [
    { provider: 'minimax', modality: 'video', model: 'video-01', usage: {} },
    { provider: 'minimax', modality: 'video', model: 'video-01', usage: {} },
    { provider: 'veo', modality: 'video', model: 'veo-3.1-generate-preview', usage: {} },
  ];
  const { unpriced } = aggregateEvents(events, []);
  assert.deepEqual(unpriced.sort((a, b) => a.provider.localeCompare(b.provider)), [
    { provider: 'minimax', modality: 'video', model: 'video-01', count: 2 },
    { provider: 'veo', modality: 'video', model: 'veo-3.1-generate-preview', count: 1 },
  ]);
});
