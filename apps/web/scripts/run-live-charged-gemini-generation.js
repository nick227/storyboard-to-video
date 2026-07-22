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

// Same wiring/intent as scripts/run-live-charged-generation.js (the OpenAI-text live-charging
// proof), adapted for Gemini text -- proving the prototype provider-cost billing policy (part F
// of the plan): the newly-promoted gemini-text customer_metered price actually reserves, settles,
// and reconciles to the ledger for a real generation, on the existing isolated test tenant.
async function main() {
  const [tenantId, userId] = process.argv.slice(2);
  if (!tenantId || !userId) throw new Error('Usage: node scripts/run-live-charged-gemini-generation.js <tenantId> <userId>');
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

    const jobId = crypto.randomUUID();
    const trace = { tenantId, userId, projectId: 'live-charge-gemini-test', jobId, idempotencyKey: `live-charge-gemini-test:${jobId}` };
    const result = await generationContext.run(
      { trace, providerSequence: 0, signal: new AbortController().signal },
      () => text.call('gemini', 'Reply with exactly: LIVE_CHARGE_GEMINI_TEST'),
    );

    const request = await prisma.generationRequest.findFirst({ where: { jobId }, orderBy: { sequence: 'desc' }, include: { usageEvent: true, creditReservation: true, costSnapshot: true } });
    const ledgerEntries = await prisma.creditLedgerEntry.findMany({ where: { generationRequestId: request.id }, orderBy: { createdAt: 'asc' } });
    const account = await prisma.creditAccount.findUnique({ where: { tenantId } });

    console.log(JSON.stringify({
      jobId, result: { model: result.model, usage: result.usage, providerRequestId: result.providerRequestId },
      generationRequest: { status: request.status, model: request.model },
      costSnapshot: request.costSnapshot && { providerCostNanoUsd: request.costSnapshot.providerCostNanoUsd.toString() },
      reservation: request.creditReservation && {
        status: request.creditReservation.status, chargingMode: request.creditReservation.chargingMode,
        reservedCreditMicros: request.creditReservation.reservedCreditMicros.toString(),
        finalCreditMicros: request.creditReservation.finalCreditMicros?.toString() ?? null,
      },
      ledgerEntries: ledgerEntries.map((entry) => ({
        type: entry.type, availableDeltaCreditMicros: entry.availableDeltaCreditMicros.toString(),
        reservedDeltaCreditMicros: entry.reservedDeltaCreditMicros.toString(),
        availableAfterCreditMicros: entry.availableAfterCreditMicros.toString(),
        reservedAfterCreditMicros: entry.reservedAfterCreditMicros.toString(),
      })),
      accountAfter: account && { availableCreditMicros: account.availableCreditMicros.toString(), reservedCreditMicros: account.reservedCreditMicros.toString() },
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
