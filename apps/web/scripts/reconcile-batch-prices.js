require('dotenv').config();

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { createTextProviders } = require('../src/providers/text');
const { createImageProviders } = require('../src/providers/image');
const { mergeMediaIntent, resolveImageOutput } = require('../src/shared/media-output-policy');
const { calculateProviderCost } = require('../src/billing/calculator');

// Makes one real, unbilled call per provider/modality to gather reconciliation evidence -- same
// approach as scripts/reconcile-openai-text-price.js, extended to a batch of providers. No
// billing/live-charging path is exercised; this only records a UsageEvent for cost comparison.
async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const identity = new PrismaIdentityRepository(prisma);
    const account = await identity.ensureLegacyIdentity('price-reconciliation');
    const usageRepository = new PrismaUsageRepository(prisma);
    const generationContext = new AsyncLocalStorage();
    const tracker = createProviderUsageService({ repository: usageRepository, generationContext });
    const cancellation = () => generationContext.getStore()?.signal;
    const text = createTextProviders(config, cancellation, tracker);
    const images = createImageProviders(config, text, cancellation, tracker);

    async function run(name, operation) {
      const jobId = crypto.randomUUID();
      const trace = { tenantId: account.tenant.id, userId: account.user.id, projectId: 'price-reconciliation', jobId, idempotencyKey: `reconcile-batch:${name}:${jobId}` };
      const result = await generationContext.run({ trace, providerSequence: 0, signal: new AbortController().signal }, operation);
      const price = await prisma.providerPriceVersion.findFirst({ where: { provider: result.provider, modality: name.includes('image') ? 'image' : 'text', model: result.model, active: true } });
      const cost = price ? calculateProviderCost(price.rateCard, result.usage) : null;
      return {
        name, model: result.model, providerRequestId: result.providerRequestId, usage: result.usage,
        computedCostUSD: cost ? Number(cost.nanoUsd) / 1e9 : null, matchedPriceVersionKey: price?.versionKey || null,
      };
    }

    const results = [];
    if (config.env.GEMINI_API_KEY) results.push(await run('gemini-text', () => text.call('gemini', 'Reply with exactly: RECONCILIATION_CHECK')));
    if (config.env.GEMINI_API_KEY) {
      const intent = mergeMediaIntent({ modality: 'image' });
      results.push(await run('gemini-image', () => images.generate({ provider: 'gemini', prompt: 'A simple black circle centered on a plain white background.', references: [], title: 'Reconciliation check', output: resolveImageOutput({ provider: 'gemini', model: 'gemini-3.1-flash-image', intent }) })));
    }
    if (config.env.OPENAI_API_KEY) {
      const intent = mergeMediaIntent({ modality: 'image' });
      results.push(await run('openai-image', () => images.generate({ provider: 'openai', prompt: 'A simple black circle centered on a plain white background.', references: [], title: 'Reconciliation check', output: resolveImageOutput({ provider: 'openai', model: 'gpt-image-1', intent }) })));
    }
    if (config.env.DEZGO_API_KEY) {
      const intent = mergeMediaIntent({ modality: 'image' });
      results.push(await run('dezgo-image', () => images.generate({ provider: 'dezgo', prompt: 'A simple black circle centered on a plain white background.', references: [], title: 'Reconciliation check', output: resolveImageOutput({ provider: 'dezgo', model: 'flux_1_schnell', intent }) })));
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
