require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { createBillingService } = require('../src/services/billing.service');
const { createTextProviders } = require('../src/providers/text');
const { createImageProviders } = require('../src/providers/image');
const { createMiniMaxAdapter } = require('../src/providers/video/minimax');
const { mergeMediaIntent, resolveImageOutput, resolveVideoOutput } = require('../src/shared/media-output-policy');

// Live-billing hardening pass (goal 5/6): runs one real generation through each of the 6
// customer-metered providers now marked billable, on the existing isolated test tenant, using the
// exact same live wiring as scripts/run-live-charged-generation.js and
// scripts/run-live-charged-gemini-generation.js -- proving reservation -> settlement -> ledger
// reconciles for every one of them, not just the two already proven individually.
async function main() {
  const [tenantId, userId] = process.argv.slice(2);
  if (!tenantId || !userId) throw new Error('Usage: node scripts/run-live-charged-provider-suite.js <tenantId> <userId>');
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const usageRepository = new PrismaUsageRepository(prisma);
    const billingRepository = new PrismaBillingRepository(prisma);
    const billing = createBillingService({ repository: billingRepository, chargingEnabled: config.billing.customerChargingEnabled });
    const generationContext = new AsyncLocalStorage();
    const usageTracker = createProviderUsageService({ repository: usageRepository, generationContext, billing });
    const cancellation = () => generationContext.getStore()?.signal;
    const text = createTextProviders(config, cancellation, usageTracker);
    const images = createImageProviders(config, text, cancellation, usageTracker);

    async function summarize(jobId, name) {
      const request = await prisma.generationRequest.findFirst({ where: { jobId }, orderBy: { sequence: 'desc' }, include: { creditReservation: true, costSnapshot: true, usageEvent: true } });
      return {
        name, status: request.status, model: request.model,
        providerRequestId: request.usageEvent?.providerRequestId || null,
        costUSD: request.costSnapshot ? Number(request.costSnapshot.providerCostNanoUsd) / 1e9 : null,
        reservation: request.creditReservation && {
          status: request.creditReservation.status, chargingMode: request.creditReservation.chargingMode,
          reservedCreditMicros: request.creditReservation.reservedCreditMicros.toString(),
          finalCreditMicros: request.creditReservation.finalCreditMicros?.toString() ?? null,
        },
      };
    }

    async function run(name, operation) {
      const jobId = crypto.randomUUID();
      const trace = { tenantId, userId, projectId: 'live-suite-test', jobId, idempotencyKey: `live-suite:${name}:${jobId}` };
      await generationContext.run({ trace, providerSequence: 0, signal: new AbortController().signal }, operation);
      return summarize(jobId, name);
    }

    const results = [];
    results.push(await run('openai-text', () => text.call('openai', 'Reply with exactly: LIVE_SUITE_TEST')));
    results.push(await run('gemini-text', () => text.call('gemini', 'Reply with exactly: LIVE_SUITE_TEST')));

    const imagePrompt = 'A simple black circle centered on a plain white background.';
    results.push(await run('openai-image', () => {
      const intent = mergeMediaIntent({ modality: 'image' });
      return images.generate({ provider: 'openai', prompt: imagePrompt, references: [], title: 'Live suite check', output: resolveImageOutput({ provider: 'openai', model: 'gpt-image-1', intent }) });
    }));
    results.push(await run('gemini-image', () => {
      const intent = mergeMediaIntent({ modality: 'image' });
      return images.generate({ provider: 'gemini', prompt: imagePrompt, references: [], title: 'Live suite check', output: resolveImageOutput({ provider: 'gemini', model: 'gemini-3.1-flash-image', intent }) });
    }));
    results.push(await run('dezgo', () => {
      const intent = mergeMediaIntent({ modality: 'image' });
      return images.generate({ provider: 'dezgo', prompt: imagePrompt, references: [], title: 'Live suite check', output: resolveImageOutput({ provider: 'dezgo', model: 'flux_1_schnell', intent }) });
    }));

    // MiniMax is asynchronous (submit -> poll -> fetch) so it drives usageTracker.begin/complete
    // directly instead of execute(), the same pattern src/services/video-execution.service.js uses.
    {
      const jobId = crypto.randomUUID();
      const trace = { tenantId, userId, projectId: 'live-suite-test', jobId, idempotencyKey: `live-suite:minimax:${jobId}` };
      const adapter = createMiniMaxAdapter(config, cancellation);
      const outputPath = path.join(os.tmpdir(), `minimax-live-suite-${Date.now()}.mp4`);
      await generationContext.run({ trace, providerSequence: 0, signal: new AbortController().signal }, async () => {
        const usageHandle = await usageTracker.begin({ modality: 'video', provider: 'minimax', model: 'MiniMax-Hailuo-02', estimatedUsage: { videos: 1 } });
        try {
          const intent = mergeMediaIntent({ modality: 'video', override: { aspectRatio: '16:9', video: { resolutionTier: 'standard', durationSeconds: 6 } } });
          const outputSelection = resolveVideoOutput({ provider: 'minimax', model: 'MiniMax-Hailuo-02', mode: 'image_to_video', intent });
          const request = {
            model: 'MiniMax-Hailuo-02', prompt: 'A calm ocean at sunset, gentle waves, soft golden light.', generationMode: 'image_to_video',
            preparedInputs: [{ role: 'start_frame', assetPath: path.resolve(__dirname, '../public/images/favicon.png') }],
            outputPath, outputSelection,
          };
          let task = await adapter.submit(request);
          const startedAt = Date.now();
          const timeoutMs = 5 * 60_000;
          while (task.state === 'submitted' || task.state === 'running') {
            if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for MiniMax task ${task.providerTaskId} after ${timeoutMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            task = await adapter.inspect(task);
          }
          if (task.state === 'failed') throw new Error(`MiniMax task failed: ${task.error?.message}`);
          const result = await adapter.fetchResult(task);
          await usageTracker.complete(usageHandle, result);
        } catch (error) {
          await usageTracker.fail(usageHandle, error);
          throw error;
        }
      });
      results.push(await summarize(jobId, 'minimax'));
    }

    console.log(JSON.stringify(results, null, 2));

    const ledger = await prisma.creditLedgerEntry.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    const ledgerSumAvailable = ledger.reduce((sum, entry) => sum + entry.availableDeltaCreditMicros, 0n);
    const ledgerSumReserved = ledger.reduce((sum, entry) => sum + entry.reservedDeltaCreditMicros, 0n);
    const account = await prisma.creditAccount.findUnique({ where: { tenantId } });
    console.log(JSON.stringify({
      reconciliation: {
        ledgerEntryCount: ledger.length,
        ledgerSumAvailableCreditMicros: ledgerSumAvailable.toString(),
        ledgerSumReservedCreditMicros: ledgerSumReserved.toString(),
        accountAvailableCreditMicros: account.availableCreditMicros.toString(),
        accountReservedCreditMicros: account.reservedCreditMicros.toString(),
        availableMatches: ledgerSumAvailable === account.availableCreditMicros,
        reservedMatches: ledgerSumReserved === account.reservedCreditMicros,
      },
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
