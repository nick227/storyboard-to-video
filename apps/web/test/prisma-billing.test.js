const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaUsageRepository } = require('../src/storage/prisma-usage.repository');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { createBillingService } = require('../src/services/billing.service');
const { createProviderUsageService } = require('../src/services/provider-usage.service');
const { providerResult } = require('../src/providers/result');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

function trackerFor(repository, billingRepository, chargingEnabled) {
  const generationContext = new AsyncLocalStorage();
  return { generationContext, tracker: createProviderUsageService({ repository, generationContext, billing: createBillingService({ repository: billingRepository, chargingEnabled }) }) };
}

test('billing snapshots costs while disabled and atomically reserves, settles, and releases seeded credits when enabled', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const usage = new PrismaUsageRepository(prisma);
  const billing = new PrismaBillingRepository(prisma);
  const account = await identity.createUserWithPersonalWorkspace({ email: `billing-${crypto.randomUUID()}@example.com`, displayName: 'Billing Audit Test', passwordHash: 'test-only' });
  const trace = (jobId) => ({ tenantId: account.tenant.id, userId: account.user.id, projectId: 'billing-audit-test', jobId, idempotencyKey: `billing:${jobId}` });
  try {
    const disabled = trackerFor(usage, billing, false);
    const disabledJob = crypto.randomUUID();
    await disabled.generationContext.run({ trace: trace(disabledJob), providerSequence: 0 }, () => disabled.tracker.execute({ modality: 'text', provider: 'openai', model: 'gpt-4.1-mini' }, async () => providerResult({ output: 'ok', provider: 'openai', model: 'gpt-4.1-mini-2025-04-14', providerRequestId: `disabled-${crypto.randomUUID()}`, usage: { inputTokens: 13, cachedInputTokens: 0, outputTokens: 3 }, measurementStatus: 'observed' })));
    const disabledRequest = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: disabledJob, sequence: 1 } }, include: { creditReservation: true, costSnapshot: true } });
    assert.equal(disabledRequest.creditReservation.chargingMode, 'charging_disabled');
    assert.equal(disabledRequest.creditReservation.status, 'settled_not_charged');
    assert.equal(disabledRequest.costSnapshot.providerCostNanoUsd, 10000n);
    assert.equal(await prisma.creditLedgerEntry.count({ where: { generationRequestId: disabledRequest.id } }), 0);

    const suffix = crypto.randomUUID();
    const provider = `billing-test-${suffix}`;
    const model = `flat-${suffix}`;
    const price = await billing.createPriceVersion({
      versionKey: `flat-price-${suffix}`, provider, modality: 'image', model, currency: 'USD',
      rateCard: { type: 'flat', quantityKey: 'images', nanoUsdPerUnit: 15000000 }, reservationNanoUsd: 20000000n,
      evidenceStatus: 'dashboard_reconciled', reconciledAt: new Date(), reconciliationNotes: 'Integration-test evidence',
      billable: true, active: true,
    });
    await assert.rejects(() => prisma.providerPriceVersion.update({ where: { id: price.id }, data: { rateCard: { type: 'flat', nanoUsdPerUnit: 1 } } }), /immutable/);
    await billing.grant({ tenantId: account.tenant.id, userId: account.user.id, creditMicros: 10000000n, idempotencyKey: `test-grant:${suffix}` });

    const live = trackerFor(usage, billing, true);
    const successJob = crypto.randomUUID();
    const result = providerResult({ output: 'image', provider, model, providerRequestId: `live-${suffix}`, usage: { images: 1 }, measurementStatus: 'observed' });
    await live.generationContext.run({ trace: trace(successJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'image', provider, model }, async () => result));
    const settled = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: successJob, sequence: 1 } }, include: { creditReservation: true, costSnapshot: true } });
    assert.equal(settled.creditReservation.status, 'settled');
    assert.equal(settled.creditReservation.reservedCreditMicros, 2000000n);
    assert.equal(settled.creditReservation.finalCreditMicros, 1500000n);
    assert.equal(settled.costSnapshot.providerCostNanoUsd, 15000000n);
    let credits = await prisma.creditAccount.findUnique({ where: { tenantId: account.tenant.id } });
    assert.equal(credits.availableCreditMicros, 8500000n);
    assert.equal(credits.reservedCreditMicros, 0n);

    const ledgerBeforeReplay = await prisma.creditLedgerEntry.count({ where: { tenantId: account.tenant.id } });
    let replayExecuted = false;
    await assert.rejects(() => live.generationContext.run({ trace: trace(successJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'image', provider, model }, async () => { replayExecuted = true; return result; })), (error) => error.code === 'DUPLICATE_PROVIDER_REQUEST');
    assert.equal(replayExecuted, false);
    assert.equal(await prisma.creditLedgerEntry.count({ where: { tenantId: account.tenant.id } }), ledgerBeforeReplay);

    const failedJob = crypto.randomUUID();
    await assert.rejects(() => live.generationContext.run({ trace: trace(failedJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'image', provider, model }, async () => { throw new Error('controlled provider failure'); })), /controlled provider failure/);
    credits = await prisma.creditAccount.findUnique({ where: { tenantId: account.tenant.id } });
    assert.equal(credits.availableCreditMicros, 8500000n);
    assert.equal(credits.reservedCreditMicros, 0n);
    const failed = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: failedJob, sequence: 1 } }, include: { creditReservation: true } });
    assert.equal(failed.creditReservation.status, 'released');
    assert.deepEqual((await prisma.creditLedgerEntry.findMany({ where: { tenantId: account.tenant.id } })).map((entry) => entry.type).sort(), ['grant', 'refund', 'release', 'reservation', 'reservation', 'settlement']);

    const expensiveModel = `expensive-${suffix}`;
    await billing.createPriceVersion({
      versionKey: `expensive-price-${suffix}`, provider, modality: 'text', model: expensiveModel, currency: 'USD',
      rateCard: { type: 'flat', nanoUsdPerUnit: 1000000000 }, reservationNanoUsd: 1000000000n,
      evidenceStatus: 'dashboard_reconciled', reconciledAt: new Date(), billable: true, active: true,
    });
    const insufficientJob = crypto.randomUUID();
    let insufficientExecuted = false;
    await assert.rejects(() => live.generationContext.run({ trace: trace(insufficientJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'text', provider, model: expensiveModel }, async () => { insufficientExecuted = true; return result; })), (error) => error.code === 'INSUFFICIENT_CREDITS');
    assert.equal(insufficientExecuted, false);
    const insufficient = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: insufficientJob, sequence: 1 } }, include: { creditReservation: true } });
    assert.equal(insufficient.status, 'failed');
    assert.equal(insufficient.creditReservation, null);

    const margins = await billing.listMargins({ tenantId: account.tenant.id });
    const margin = margins.find((row) => row.generationRequestId === settled.id);
    assert.equal(margin.finalCustomerNanoUsd - margin.providerCostSnapshot.providerCostNanoUsd, 0n);

    await assert.rejects(() => prisma.providerCostSnapshot.update({ where: { id: settled.costSnapshot.id }, data: { providerCostNanoUsd: 1n } }), /append-only/);
    await assert.rejects(() => prisma.creditReservation.update({ where: { id: settled.creditReservation.id }, data: { finalCreditMicros: 1n } }), /immutable/);
    const ledger = await prisma.creditLedgerEntry.findFirst({ where: { tenantId: account.tenant.id } });
    await assert.rejects(() => prisma.creditLedgerEntry.update({ where: { id: ledger.id }, data: { metadata: { changed: true } } }), /append-only/);
  } finally {
    await prisma.$disconnect();
  }
});
