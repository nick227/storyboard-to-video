require('dotenv').config();

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { createMiniMaxAdapter } = require('../src/providers/video/minimax');
const { mergeMediaIntent, resolveVideoOutput } = require('../src/shared/media-output-policy');
const { calculateProviderCost } = require('../src/billing/calculator');

// Makes one real MiniMax video generation to gather reconciliation evidence -- same intent as
// scripts/reconcile-batch-prices.js, but MiniMax is asynchronous (submit -> poll -> download), so
// it drives the adapter's own submit/inspect/fetchResult directly rather than going through the
// durable-attempt-tracking video-execution.service.js layer, which exists for production job
// recovery this one-off script doesn't need. No billing/live-charging path is exercised.
async function main() {
  const config = loadConfig();
  if (!config.env.MINIMAX_API_KEY) throw new Error('MINIMAX_API_KEY is required');
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const adapter = createMiniMaxAdapter(config, () => null);
  const outputPath = path.join(os.tmpdir(), `minimax-reconciliation-${Date.now()}.mp4`);
  try {
    await adapter.verify();
    console.log('verified MiniMax API key');

    const intent = mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'standard', durationSeconds: 6 } } });
    const outputSelection = resolveVideoOutput({ provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'image_to_video', intent });

    const request = {
      model: 'MiniMax-Hailuo-02',
      prompt: 'A calm ocean at sunset, gentle waves, soft golden light.',
      generationMode: 'image_to_video',
      preparedInputs: [{ role: 'start_frame', assetPath: path.resolve(__dirname, '../public/images/favicon.png') }],
      outputPath,
      outputSelection,
    };

    console.log('submitting real MiniMax video generation...');
    let task = await adapter.submit(request);
    console.log(`submitted: providerTaskId=${task.providerTaskId}`);

    const startedAt = Date.now();
    const timeoutMs = 5 * 60_000;
    while (task.state === 'submitted' || task.state === 'running') {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for MiniMax task ${task.providerTaskId} after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      task = await adapter.inspect(task);
      console.log(`poll: state=${task.state} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
    }

    if (task.state === 'failed') throw new Error(`MiniMax task failed: ${task.error?.message}`);

    const result = await adapter.fetchResult(task);
    const stat = fs.statSync(result.output.outputPath);
    const price = await prisma.providerPriceVersion.findFirst({ where: { provider: 'minimax', modality: 'video', model: result.model, active: true } });
    const cost = price ? calculateProviderCost(price.rateCard, result.usage) : null;

    console.log(JSON.stringify({
      model: result.model, providerRequestId: result.providerRequestId, usage: result.usage,
      outputBytes: stat.size, outputPath: result.output.outputPath,
      computedCostUSD: cost ? Number(cost.nanoUsd) / 1e9 : null, matchedPriceVersionKey: price?.versionKey || null,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
