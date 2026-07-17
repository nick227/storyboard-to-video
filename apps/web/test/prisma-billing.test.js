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
  await prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
    await db.creditLedgerEntry.deleteMany({ where: { tenantId: account.tenant.id, type: 'welcome_grant' } });
    await db.creditAccount.update({ where: { tenantId: account.tenant.id }, data: { availableCreditMicros: 0n } });
    await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
  });
  const trace = (jobId) => ({ tenantId: account.tenant.id, userId: account.user.id, projectId: 'billing-audit-test', jobId, idempotencyKey: `billing:${jobId}` });
  let testProvider;
  let welcomePolicyId;
  try {
    const welcomePolicy = await billing.createWelcomeCreditPolicyVersion({ versionKey: `welcome-test-${crypto.randomUUID()}`, name: 'Future registration test', creditMicros: 123000000n, active: false, createdByAdminId: account.user.id });
    welcomePolicyId = welcomePolicy.id;
    assert.equal((await billing.listWelcomeCreditPolicies()).some((policy) => policy.id === welcomePolicy.id), true);
    await assert.rejects(() => prisma.welcomeCreditPolicyVersion.update({ where: { id: welcomePolicy.id }, data: { creditMicros: 1n } }), /immutable/);
    assert.throws(() => billing.createPriceVersion({
      versionKey: `unreconciled-${crypto.randomUUID()}`, provider: 'test', modality: 'text', model: 'test', currency: 'USD',
      rateCard: { type: 'flat', nanoUsdPerUnit: 1 }, reservationNanoUsd: 1n, evidenceStatus: 'documented', billable: true, active: false,
    }), (error) => error.code === 'PRICE_NOT_RECONCILED');

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
    testProvider = provider;
    const model = `flat-${suffix}`;
    const price = await billing.createPriceVersion({
      versionKey: `flat-price-${suffix}`, provider, modality: 'image', model, currency: 'USD',
      rateCard: { type: 'flat', quantityKey: 'images', nanoUsdPerUnit: 15000000 }, reservationNanoUsd: 20000000n,
      evidenceStatus: 'dashboard_reconciled', reconciledAt: new Date(), reconciliationNotes: 'Integration-test evidence',
      billable: true, active: true,
    });
    await assert.rejects(() => prisma.providerPriceVersion.update({ where: { id: price.id }, data: { rateCard: { type: 'flat', nanoUsdPerUnit: 1 } } }), /immutable/);
    await billing.grant({ tenantId: account.tenant.id, userId: account.user.id, creditMicros: 10000000n, idempotencyKey: `test-grant:${suffix}` });
    const enableKey = `test-enable:${suffix}`;
    const enabledAccount = await billing.setChargingEnabled({ tenantId: account.tenant.id, enabled: true, actorUserId: account.user.id, idempotencyKey: enableKey });
    assert.equal(enabledAccount.account.chargingEnabled, true);
    assert.equal(enabledAccount.account.chargingChangedByUserId, account.user.id);
    assert.ok(enabledAccount.account.chargingChangedAt instanceof Date);
    assert.equal((await billing.setChargingEnabled({ tenantId: account.tenant.id, enabled: true, actorUserId: account.user.id, idempotencyKey: enableKey })).reused, true);

    const live = trackerFor(usage, billing, true);
    const successJob = crypto.randomUUID();
    const result = providerResult({ output: 'image', provider, model, providerRequestId: `live-${suffix}`, usage: { images: 1 }, measurementStatus: 'observed' });
    await live.generationContext.run({ trace: trace(successJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'image', provider, model }, async () => {
      await billing.setChargingEnabled({ tenantId: account.tenant.id, enabled: false, actorUserId: account.user.id, idempotencyKey: `test-disable-inflight:${suffix}` });
      return result;
    }));
    const settled = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: successJob, sequence: 1 } }, include: { creditReservation: true, costSnapshot: true } });
    assert.equal(settled.creditReservation.status, 'settled');
    assert.equal(settled.creditReservation.reservedCreditMicros, 2000000n);
    assert.equal(settled.creditReservation.finalCreditMicros, 1500000n);
    assert.equal(settled.costSnapshot.providerCostNanoUsd, 15000000n);
    let credits = await prisma.creditAccount.findUnique({ where: { tenantId: account.tenant.id } });
    assert.equal(credits.availableCreditMicros, 8500000n);
    assert.equal(credits.reservedCreditMicros, 0n);
    assert.equal(credits.chargingEnabled, false);

    const disabledTenantJob = crypto.randomUUID();
    const ledgerBeforeDisabledTenant = await prisma.creditLedgerEntry.count({ where: { tenantId: account.tenant.id } });
    await live.generationContext.run({ trace: trace(disabledTenantJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'image', provider, model }, async () => ({ ...result, providerRequestId: `tenant-disabled-${suffix}` })));
    const disabledTenantRequest = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: disabledTenantJob, sequence: 1 } }, include: { creditReservation: true, costSnapshot: true } });
    assert.equal(disabledTenantRequest.creditReservation.chargingMode, 'tenant_charging_disabled');
    assert.equal(disabledTenantRequest.creditReservation.status, 'settled_not_charged');
    assert.equal(disabledTenantRequest.costSnapshot.providerCostNanoUsd, 15000000n);
    assert.equal(await prisma.creditLedgerEntry.count({ where: { tenantId: account.tenant.id } }), ledgerBeforeDisabledTenant);

    const ledgerBeforeReplay = await prisma.creditLedgerEntry.count({ where: { tenantId: account.tenant.id } });
    let replayExecuted = false;
    await assert.rejects(() => live.generationContext.run({ trace: trace(successJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'image', provider, model }, async () => { replayExecuted = true; return result; })), (error) => error.code === 'DUPLICATE_PROVIDER_REQUEST');
    assert.equal(replayExecuted, false);
    assert.equal(await prisma.creditLedgerEntry.count({ where: { tenantId: account.tenant.id } }), ledgerBeforeReplay);

    await billing.setChargingEnabled({ tenantId: account.tenant.id, enabled: true, actorUserId: account.user.id, idempotencyKey: `test-reenable-release:${suffix}` });
    const failedJob = crypto.randomUUID();
    await assert.rejects(() => live.generationContext.run({ trace: trace(failedJob), providerSequence: 0 }, () => live.tracker.execute({ modality: 'image', provider, model }, async () => {
      await billing.setChargingEnabled({ tenantId: account.tenant.id, enabled: false, actorUserId: account.user.id, idempotencyKey: `test-disable-before-release:${suffix}` });
      throw new Error('controlled provider failure');
    })), /controlled provider failure/);
    credits = await prisma.creditAccount.findUnique({ where: { tenantId: account.tenant.id } });
    assert.equal(credits.availableCreditMicros, 8500000n);
    assert.equal(credits.reservedCreditMicros, 0n);
    const failed = await prisma.generationRequest.findUnique({ where: { jobId_sequence: { jobId: failedJob, sequence: 1 } }, include: { creditReservation: true } });
    assert.equal(failed.creditReservation.status, 'released');
    assert.equal(credits.chargingEnabled, false);

    await billing.setChargingEnabled({ tenantId: account.tenant.id, enabled: true, actorUserId: account.user.id, idempotencyKey: `test-reenable-insufficient:${suffix}` });

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

    const ledgerTypes = (await prisma.creditLedgerEntry.findMany({ where: { tenantId: account.tenant.id } })).map((entry) => entry.type);
    assert.equal(ledgerTypes.filter((type) => type === 'charging_enabled').length, 3);
    assert.equal(ledgerTypes.filter((type) => type === 'charging_disabled').length, 2);
    assert.equal(ledgerTypes.filter((type) => type === 'reservation').length, 2);
    assert.ok(ledgerTypes.includes('settlement'));
    assert.ok(ledgerTypes.includes('refund'));
    assert.ok(ledgerTypes.includes('release'));

    const margins = await billing.listMargins({ tenantId: account.tenant.id });
    const margin = margins.find((row) => row.generationRequestId === settled.id);
    assert.equal(margin.finalCustomerNanoUsd - margin.providerCostSnapshot.providerCostNanoUsd, 0n);

    await assert.rejects(() => prisma.providerCostSnapshot.update({ where: { id: settled.costSnapshot.id }, data: { providerCostNanoUsd: 1n } }), /append-only/);
    await assert.rejects(() => prisma.creditReservation.update({ where: { id: settled.creditReservation.id }, data: { finalCreditMicros: 1n } }), /immutable/);
    const ledger = await prisma.creditLedgerEntry.findFirst({ where: { tenantId: account.tenant.id } });
    await assert.rejects(() => prisma.creditLedgerEntry.update({ where: { id: ledger.id }, data: { metadata: { changed: true } } }), /append-only/);
  } finally {
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE provider_cost_snapshots DISABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_reservations DISABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE welcome_credit_policy_versions DISABLE TRIGGER USER');
      await db.creditLedgerEntry.deleteMany({ where: { tenantId: account.tenant.id } });
      await db.creditReservation.deleteMany({ where: { tenantId: account.tenant.id } });
      await db.providerCostSnapshot.deleteMany({ where: { generationRequest: { tenantId: account.tenant.id } } });
      await db.usageEvent.deleteMany({ where: { tenantId: account.tenant.id } });
      await db.generationRequest.deleteMany({ where: { tenantId: account.tenant.id } });
      await db.creditAccount.deleteMany({ where: { tenantId: account.tenant.id } });
      if (testProvider) await db.providerPriceVersion.deleteMany({ where: { provider: testProvider } });
      if (welcomePolicyId) await db.welcomeCreditPolicyVersion.deleteMany({ where: { id: welcomePolicyId } });
      await db.workspace.deleteMany({ where: { id: account.tenant.id } });
      await db.user.deleteMany({ where: { id: account.user.id } });
      await db.$executeRawUnsafe('ALTER TABLE credit_reservations ENABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE provider_cost_snapshots ENABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE welcome_credit_policy_versions ENABLE TRIGGER USER');
    });
    await prisma.$disconnect();
  }
});
