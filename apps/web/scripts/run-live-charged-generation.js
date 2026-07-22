require('dotenv').config();

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { createBillingService } = require('../src/services/billing.service');
const { createTextProviders } = require('../src/providers/text');

// Exercises the identical dependency wiring dependencies.js builds for the real HTTP server
// (usageTracker -> billing -> provider-usage.repository), so a live-charged reservation and
// settlement run through the exact same code the app itself would use for a real request.
async function main() {
  const [tenantId, userId, mode, model] = process.argv.slice(2);
  if (!tenantId || !userId || !['succeed', 'fail'].includes(mode)) {
    throw new Error('Usage: node scripts/run-live-charged-generation.js <tenantId> <userId> <succeed|fail> [modelOverride]');
  }
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const usageRepository = new PrismaUsageRepository(prisma);
    const billingRepository = new PrismaBillingRepository(prisma);
    const billing = createBillingService({ repository: billingRepository, chargingEnabled: config.billing.customerChargingEnabled });
    const generationContext = new AsyncLocalStorage();
    const usageTracker = createProviderUsageService({ repository: usageRepository, generationContext, billing });
    const cancellation = () => generationContext.getStore()?.signal;
    // Sabotage the API key (not the model) so the reservation still matches the real billable
    // gpt-4.1-mini price and goes live -- only the downstream provider call itself fails,
    // exercising billing.release() on an actual live reservation rather than the unrelated
    // no_active_price/monitoring path an invalid model name would hit instead.
    const effectiveConfig = mode === 'fail'
      ? { ...config, env: { ...config.env, OPENAI_API_KEY: model || `sk-invalid-live-test-key-${crypto.randomUUID()}` } }
      : config;
    const text = createTextProviders(effectiveConfig, cancellation, usageTracker);

    const jobId = crypto.randomUUID();
    const trace = { tenantId, userId, projectId: 'live-charge-test', jobId, idempotencyKey: `live-charge-test:${jobId}` };
    let result; let error;
    try {
      result = await generationContext.run(
        { trace, providerSequence: 0, signal: new AbortController().signal },
        () => text.call('openai', 'Reply with exactly: LIVE_CHARGE_TEST'),
      );
    } catch (err) { error = { code: err.code, message: err.message }; }

    const request = await prisma.generationRequest.findFirst({ where: { jobId }, orderBy: { sequence: 'desc' }, include: { usageEvent: true, creditReservation: true } });
    console.log(JSON.stringify({
      mode, jobId, error, result: result && { model: result.model, usage: result.usage, providerRequestId: result.providerRequestId },
      generationRequest: request && { status: request.status, model: request.model },
      reservation: request?.creditReservation && {
        status: request.creditReservation.status, chargingMode: request.creditReservation.chargingMode,
        reservedCreditMicros: request.creditReservation.reservedCreditMicros.toString(),
        finalCreditMicros: request.creditReservation.finalCreditMicros?.toString() ?? null,
      },
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
