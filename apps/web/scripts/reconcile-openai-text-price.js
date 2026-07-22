require('dotenv').config();

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { createTextProviders } = require('../src/providers/text');
const { calculateProviderCost } = require('../src/billing/calculator');

// Makes exactly one real gpt-4.1-mini call (no billing/live-charging involved -- this only
// records a UsageEvent for cost-reconciliation evidence) so the resulting token counts can be
// cross-checked against the real OpenAI usage dashboard before marking that price billable.
async function main() {
  const config = loadConfig();
  if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const identity = new PrismaIdentityRepository(prisma);
    const generationContext = new AsyncLocalStorage();
    const repository = new PrismaUsageRepository(prisma);
    const tracker = createProviderUsageService({ repository, generationContext });
    const cancellation = () => generationContext.getStore()?.signal;
    const text = createTextProviders(config, cancellation, tracker);
    const account = await identity.ensureLegacyIdentity('price-reconciliation');
    const jobId = crypto.randomUUID();
    const trace = { tenantId: account.tenant.id, userId: account.user.id, projectId: 'price-reconciliation', jobId, idempotencyKey: `reconcile-openai-text:${jobId}` };

    const result = await generationContext.run(
      { trace, providerSequence: 0, signal: new AbortController().signal },
      () => text.call('openai', 'Reply with exactly: RECONCILIATION_CHECK'),
    );

    const price = await prisma.providerPriceVersion.findFirst({ where: { provider: 'openai', modality: 'text', model: result.model, active: true } });
    const cost = price ? calculateProviderCost(price.rateCard, result.usage) : null;

    console.log(JSON.stringify({
      model: result.model,
      providerRequestId: result.providerRequestId,
      usage: result.usage,
      computedCostUSD: cost ? Number(cost.nanoUsd) / 1e9 : null,
      calculation: cost?.calculation,
      timestampUTC: new Date().toISOString(),
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
