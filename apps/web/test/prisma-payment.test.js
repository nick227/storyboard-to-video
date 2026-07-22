const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaPaymentRepository } = require('../src/storage/prisma-payment.repository');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { createPaymentService } = require('../src/services/payment.service');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

test('Stripe checkout funds once, expires safely, blocks consumed-credit refunds, and records disputes', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const repository = new PrismaPaymentRepository(prisma);
  const customer = await identity.createUserWithPersonalWorkspace({ email: `stripe-${crypto.randomUUID()}@example.com`, displayName: 'Stripe Customer', passwordHash: 'test-only' });
  await prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
    await db.creditLedgerEntry.deleteMany({ where: { tenantId: customer.tenant.id, type: 'welcome_grant' } });
    await db.creditAccount.deleteMany({ where: { tenantId: customer.tenant.id } });
    await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
  });
  const suffix = crypto.randomUUID();
  // Only one SiteCreditRateVersion may be active at a time (a partial unique index enforces it),
  // so a raw create with active:true directly collides with whatever real rate is already
  // active. Deactivate-then-activate through the repository instead, and restore the previously
  // active rate in `finally` -- this test shouldn't change real business config as a side effect.
  const billingRepository = new PrismaBillingRepository(prisma);
  const previouslyActiveRate = await billingRepository.activeCreditRate();
  const creditRate = await billingRepository.createCreditRateVersion({ versionKey: `stripe-test-${suffix}`, nanoUsdPerSiteCredit: 10000000n, active: false });
  await billingRepository.activateCreditRate(creditRate.id);
  let sessionNumber = 0; let refundCalls = 0;
  const stripe = {
    checkout: { sessions: { create: async (params, options) => {
      sessionNumber += 1;
      assert.equal(params.mode, 'payment'); assert.equal(params.automatic_tax, undefined); assert.equal(params.line_items[0].price_data.unit_amount, 1000); assert.match(options.idempotencyKey, /^checkout:/);
      return { id: `cs_test_${sessionNumber}_${suffix}`, url: `https://checkout.stripe.test/${sessionNumber}`, customer: null };
    } } },
    refunds: { create: async (params, options) => { refundCalls += 1; assert.match(options.idempotencyKey, /^refund:/); return { id: `re_test_${refundCalls}_${suffix}`, amount: params.amount, payment_intent: params.payment_intent, metadata: params.metadata }; } },
    webhooks: { constructEvent: () => { throw new Error('not used'); } },
  };
  const payments = createPaymentService({ repository, stripe, webhookSecret: 'whsec_test', publicAppUrl: 'http://localhost:3000' });

  const sales = [];
  async function checkout(key = crypto.randomUUID()) {
    const result = await payments.createCheckout({ amount: 1000, tenantId: customer.tenant.id, userId: customer.user.id, userEmail: customer.user.email, idempotencyKey: key });
    sales.push(result.saleId); return result;
  }
  function completed(result, eventId = `evt_${crypto.randomUUID()}`) {
    return { id: eventId, type: 'checkout.session.completed', data: { object: { id: result.checkoutSessionId, client_reference_id: result.saleId, metadata: { saleId: result.saleId, tenantId: customer.tenant.id, userId: customer.user.id }, payment_status: 'paid', amount_subtotal: 1000, amount_total: 1000, total_details: { amount_tax: 0 }, currency: 'usd', customer: `cus_${suffix}`, payment_intent: `pi_${result.saleId}`, created: Math.floor(Date.now() / 1000) } } };
  }

  try {
    const key = crypto.randomUUID();
    const first = await checkout(key);
    const replay = await payments.createCheckout({ amount: 1000, tenantId: customer.tenant.id, userId: customer.user.id, userEmail: customer.user.email, idempotencyKey: key });
    assert.equal(replay.saleId, first.saleId); assert.equal(replay.url, first.url); assert.equal(sessionNumber, 1);
    const paidEvent = completed(first, `evt_paid_${suffix}`);
    await payments.processWebhook(paidEvent);
    const duplicate = await payments.processWebhook(paidEvent);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await repository.account(customer.tenant.id)).availableCreditMicros, 1000000000n);
    assert.equal(await prisma.creditLedgerEntry.count({ where: { saleId: first.saleId, type: 'purchase_funding' } }), 1);
    assert.equal((await repository.purchaseStatus({ saleId: first.saleId, tenantId: customer.tenant.id, userId: customer.user.id })).status, 'credits_funded');

    const abandoned = await checkout();
    await payments.processWebhook({ id: `evt_expired_${suffix}`, type: 'checkout.session.expired', data: { object: { id: abandoned.checkoutSessionId, client_reference_id: abandoned.saleId, metadata: { saleId: abandoned.saleId } } } });
    assert.equal((await repository.purchaseStatus({ saleId: abandoned.saleId, tenantId: customer.tenant.id, userId: customer.user.id })).status, 'expired');
    await assert.rejects(() => payments.processWebhook(completed(abandoned, `evt_late_paid_${suffix}`)), (error) => error.code === 'INVALID_SALE_TRANSITION');
    assert.equal((await repository.account(customer.tenant.id)).availableCreditMicros, 1000000000n);

    const mismatch = await checkout();
    const bad = completed(mismatch, `evt_bad_${suffix}`); bad.data.object.amount_subtotal = 999;
    await assert.rejects(() => payments.processWebhook(bad), (error) => error.code === 'PAYMENT_AMOUNT_MISMATCH');
    assert.equal((await prisma.paymentEvent.findUnique({ where: { processorEventId: bad.id } })).status, 'failed');
    assert.equal((await repository.purchaseStatus({ saleId: mismatch.saleId, tenantId: customer.tenant.id, userId: customer.user.id })).creditLedgerEntryId, null);

    const refund = await payments.refundSale({ saleId: first.saleId, reason: 'requested_by_customer', idempotencyKey: crypto.randomUUID() });
    assert.equal(refund.sale.status, 'refunded');
    assert.equal((await repository.account(customer.tenant.id)).availableCreditMicros, 0n);
    await payments.processWebhook({ id: `evt_refund_${suffix}`, type: 'refund.created', data: { object: refund.refund } });
    assert.equal(await prisma.creditLedgerEntry.count({ where: { saleId: first.saleId, type: 'purchase_refund' } }), 1);

    const consumed = await checkout(); await payments.processWebhook(completed(consumed));
    await prisma.creditAccount.update({ where: { tenantId: customer.tenant.id }, data: { availableCreditMicros: 0n } });
    await assert.rejects(() => payments.refundSale({ saleId: consumed.saleId, reason: 'requested_by_customer', idempotencyKey: crypto.randomUUID() }), (error) => error.code === 'REFUND_CREDITS_CONSUMED');
    assert.equal(refundCalls, 1);
    const externalRefund = { id: `re_external_${suffix}`, amount: 1000, payment_intent: `pi_${consumed.saleId}`, metadata: { saleId: consumed.saleId } };
    await payments.processWebhook({ id: `evt_external_refund_${suffix}`, type: 'refund.created', data: { object: externalRefund } });
    const unresolved = await repository.purchaseStatus({ saleId: consumed.saleId, tenantId: customer.tenant.id, userId: customer.user.id });
    assert.equal(unresolved.refundResolutionRequired, true); assert.equal(unresolved.creditsReversed, 0n);
    assert.equal((await repository.account(customer.tenant.id)).availableCreditMicros, 0n);
    await payments.processWebhook({ id: `evt_dispute_${suffix}`, type: 'charge.dispute.created', data: { object: { id: `dp_${suffix}`, payment_intent: `pi_${consumed.saleId}` } } });
    assert.equal((await repository.purchaseStatus({ saleId: consumed.saleId, tenantId: customer.tenant.id, userId: customer.user.id })).status, 'disputed');
  } finally {
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_sales DISABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_packs DISABLE TRIGGER USER');
      await db.paymentEvent.deleteMany({ where: { OR: [{ saleId: { in: sales } }, { processorEventId: { contains: suffix } }] } });
      await db.checkoutAttempt.deleteMany({ where: { saleId: { in: sales } } });
      await db.creditSale.updateMany({ where: { id: { in: sales } }, data: { creditLedgerEntryId: null } });
      await db.creditLedgerEntry.deleteMany({ where: { tenantId: customer.tenant.id } });
      await db.creditSale.deleteMany({ where: { id: { in: sales } } });
      await db.paymentCustomer.deleteMany({ where: { tenantId: customer.tenant.id } });
      await db.creditAccount.deleteMany({ where: { tenantId: customer.tenant.id } });
      // Deliberately not deleted: this rate is a globally-shared resource for the moment it's
      // active, so any real concurrent billing activity elsewhere on this DB during that window
      // can attach a CreditReservation to it, which would make a hard delete here race against
      // real traffic (FK violation). Leaving it retired-but-present is safe and matches how
      // other pricing/rate config rows are treated as permanent history elsewhere in this repo.
      await db.workspace.delete({ where: { id: customer.tenant.id } });
      await db.user.delete({ where: { id: customer.user.id } });
      await db.$executeRawUnsafe('ALTER TABLE credit_packs ENABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_sales ENABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
    });
    if (previouslyActiveRate) await billingRepository.activateCreditRate(previouslyActiveRate.id);
    await prisma.$disconnect();
  }
});
