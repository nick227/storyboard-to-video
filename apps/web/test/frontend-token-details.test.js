const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { aggregateEvents } = require('../src/services/spend-summary.service');

const tokenDetailsPromise = import(path.join(__dirname, '..', 'public', 'js', 'billing', 'token-details.js'));

test('token details view model keeps modality totals and builds sortable request rows', async () => {
  const { buildTokenDetailsViewModel } = await tokenDetailsPromise;
  const viewModel = buildTokenDetailsViewModel({
    totalCredits: 2.5,
    totalCostUSD: 0.06,
    totalTokens: 1500,
    providers: {
      piper: {
        modalities: {
          audio: {
            costUSD: 0.01,
            count: 123,
            models: {},
          },
        },
      },
      openai: {
        modalities: {
          text: {
            costUSD: 0.05,
            count: 1,
            models: {},
          },
        },
      },
    },
    requests: [
      {
        id: 'a',
        occurredAt: '2026-07-20T12:00:00.000Z',
        modality: 'audio',
        provider: 'piper',
        model: 'voice-model',
        sceneId: 'scene-1',
        costUSD: 0.01,
        credits: 0.5,
        billingTier: 'platform_overhead',
        count: 123,
        seconds: 2.25,
        file: { bytes: 9_999_999 },
      },
      {
        id: 'b',
        occurredAt: '2026-07-21T12:00:00.000Z',
        modality: 'text',
        provider: 'openai',
        model: 'gpt-4o',
        sceneId: null,
        costUSD: 0.05,
        credits: 2,
        inputTokens: 1000,
        outputTokens: 500,
        tokens: 1500,
        file: {},
      },
    ],
  }, { sortKey: 'costUSD', sortDir: 'desc' });

  assert.equal(viewModel.groups.length, 2);
  assert.equal(viewModel.requests[0].id, 'b');
  assert.equal(viewModel.requests[0].costLabel, '$0.05000');
  assert.equal(viewModel.requests[0].creditsLabel, '2.0000');
  assert.equal(viewModel.requests[1].costLabel, 'Included');
  assert.match(viewModel.requests[1].fileLabel, /123 chars/);
  assert.match(viewModel.requests[1].fileLabel, /2\.3s/);
  assert.match(viewModel.requests[1].provenance, /piper \/ voice-model · scene scene-1/);
});

test('aggregateEvents returns newest-first request rows with provenance and file metadata', () => {
  const events = [
    {
      id: 'old',
      generationRequestId: 'req-old',
      occurredAt: new Date('2026-07-01T00:00:00.000Z'),
      provider: 'openai',
      modality: 'text',
      model: 'gpt-4o',
      sceneId: 'sc-1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      generationRequest: {
        sceneId: 'sc-1',
        outputMetadata: { kind: 'text', characters: 40 },
        creditReservation: { finalCreditMicros: 1_500_000n },
      },
      costSnapshot: { providerCostNanoUsd: 10_000_000n },
    },
    {
      id: 'new',
      generationRequestId: 'req-new',
      occurredAt: new Date('2026-07-02T00:00:00.000Z'),
      provider: 'ltx',
      modality: 'video',
      model: 'ltx-video',
      sceneId: 'sc-2',
      usage: { videos: 1, frames: 121, seconds: 5 },
      generationRequest: {
        sceneId: 'sc-2',
        outputMetadata: { kind: 'object', bytes: 2048, mimeType: 'video/mp4', extension: 'mp4', outputPath: '/tmp/out.mp4' },
        creditReservation: null,
      },
    },
  ];
  const prices = [{
    provider: 'ltx',
    modality: 'video',
    model: 'ltx-video',
    billingTier: 'platform_overhead',
    rateCard: { type: 'flat', nanoUsdPerUnit: 15_000_000, quantityKey: 'videos' },
  }];

  const { requests, totalCostUSD, platformCostUSD } = aggregateEvents(events, prices);
  assert.equal(requests[0].id, 'req-new');
  assert.equal(requests[0].sceneId, 'sc-2');
  assert.equal(requests[0].file.mimeType, 'video/mp4');
  assert.equal(requests[0].file.outputPath, '/tmp/out.mp4');
  assert.equal(requests[0].billingTier, 'platform_overhead');
  assert.equal(requests[1].credits, 1.5);
  assert.equal(totalCostUSD, 0.01);
  assert.equal(platformCostUSD, 0.015);
});
