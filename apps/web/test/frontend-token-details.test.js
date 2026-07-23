const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const tokenDetailsPromise = import(path.join(__dirname, '..', 'public', 'js', 'billing', 'token-details.js'));

test('token details view model pivots providers and uses measured audio duration', async () => {
  const { buildTokenDetailsViewModel } = await tokenDetailsPromise;
  const viewModel = buildTokenDetailsViewModel({
    totalCredits: 2,
    providers: {
      piper: {
        modalities: {
          audio: {
            costUSD: 0.01,
            models: {
              'voice-model-without-provider-name': {
                costUSD: 0.01,
                count: 123,
                tokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                extra: { bytes: 9_999_999, seconds: 2.25 },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(viewModel.groups.length, 1);
  assert.equal(viewModel.groups[0].key, 'audio');
  assert.equal(viewModel.groups[0].items[0].usage, '123 character(s) (~2.3s audio)');
});

test('token details pricing merges configured rates with unconfigured supported video models', async () => {
  const { buildTokenDetailsViewModel } = await tokenDetailsPromise;
  const viewModel = buildTokenDetailsViewModel({
    activePrices: [{
      provider: 'veo',
      modality: 'video',
      model: 'configured',
      rateCard: { type: 'flat', nanoUsdPerUnit: 10_000_000 },
    }],
    videoModels: [
      { provider: 'veo', model: 'configured', modes: ['text_to_video'] },
      { provider: 'veo', model: 'unconfigured', modes: ['first_last_frame'], isDefault: true },
    ],
  });

  assert.equal(viewModel.pricingRows.length, 2);
  assert.equal(viewModel.pricingRows[0].rate, '$0.0100 flat rate');
  assert.deepEqual(viewModel.pricingRows[1], {
    provider: 'veo',
    modality: 'video',
    model: 'unconfigured',
    isDefault: true,
    rate: 'Rate not configured · first last frame',
  });
});
