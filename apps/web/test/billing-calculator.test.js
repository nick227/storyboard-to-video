const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMarkup, calculateProviderCost, convertNanoUsdToCreditMicros } = require('../src/billing/calculator');

test('frozen provider rate cards reproduce the July validation costs exactly', () => {
  const cases = [
    [{ type: 'token_components', components: [{ usageKey: 'inputTokens', subtractUsageKey: 'cachedInputTokens', nanoUsdPerMillion: 400000000 }, { usageKey: 'cachedInputTokens', nanoUsdPerMillion: 100000000 }, { usageKey: 'outputTokens', nanoUsdPerMillion: 1600000000 }] }, { inputTokens: 13, cachedInputTokens: 0, outputTokens: 3 }, 10000n],
    [{ type: 'token_components', components: [{ usageKey: 'inputTokens', nanoUsdPerMillion: 1500000000 }, { usageKey: 'outputTokens', nanoUsdPerMillion: 9000000000 }] }, { inputTokens: 11, outputTokens: 293 }, 2653500n],
    [{ type: 'token_components', components: [{ usageKey: 'inputTextTokens', nanoUsdPerMillion: 5000000000 }, { usageKey: 'inputImageTokens', nanoUsdPerMillion: 10000000000 }, { usageKey: 'outputImageTokens', nanoUsdPerMillion: 40000000000 }] }, { inputTextTokens: 17, inputImageTokens: 0, outputImageTokens: 1056 }, 42325000n],
    [{ type: 'token_components', components: [{ usageKey: 'inputTokens', nanoUsdPerMillion: 500000000 }, { usageKey: 'outputTextOrThinkingTokens', nanoUsdPerMillion: 3000000000 }, { usageKey: 'outputImageTokens', nanoUsdPerMillion: 60000000000 }] }, { inputTokens: 11, outputTextOrThinkingTokens: 328, outputImageTokens: 1120 }, 68189500n],
    [{ type: 'linear_steps', usageKey: 'steps', quantityKey: 'images', baseNanoUsd: 18100000, baseUnits: 30 }, { steps: 25, images: 1 }, 15083333n],
  ];
  const costs = cases.map(([rate, usage, expected]) => {
    const result = calculateProviderCost(rate, usage);
    assert.equal(result.nanoUsd, expected);
    return result.nanoUsd;
  });
  assert.equal(costs.reduce((sum, value) => sum + value, 0n), 128261333n);
});

test('matrix rate cards price the exact resolved provider tuple and reject unpriced output', () => {
  const rate = { type: 'matrix', entries: [
    { when: { resolution: '768P', seconds: 6 }, nanoUsdPerUnit: 500000000, quantityKey: 'videos' },
    { when: { resolution: '1080P', seconds: 6 }, nanoUsdPerUnit: 1000000000, quantityKey: 'videos' },
  ] };
  assert.equal(calculateProviderCost(rate, { resolution: '1080P', seconds: 6, videos: 2 }).nanoUsd, 2000000000n);
  assert.throws(() => calculateProviderCost(rate, { resolution: '1080P', seconds: 10, videos: 1 }), /No provider price matches/);
});

test('markup and site-credit conversion use deterministic integer rounding', () => {
  assert.equal(applyMarkup(15083333n, { markupBasisPoints: 2500, fixedNanoUsd: 0n }), 18854166n);
  assert.equal(convertNanoUsdToCreditMicros(18854166n, { nanoUsdPerSiteCredit: 10000000n }), 1885417n);
});
