const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

test('billing repository retries real Postgres serialization conflicts under concurrent writes to the same account, and still propagates non-retryable errors immediately', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const billing = new PrismaBillingRepository(prisma);
  const account = await identity.createUserWithPersonalWorkspace({ email: `billing-retry-${crypto.randomUUID()}@example.com`, displayName: 'Billing Retry Test', passwordHash: 'test-only' });
  const originalTransaction = prisma.$transaction.bind(prisma);
  try {
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
      await db.creditLedgerEntry.deleteMany({ where: { tenantId: account.tenant.id, type: 'welcome_grant' } });
      await db.creditAccount.update({ where: { tenantId: account.tenant.id }, data: { availableCreditMicros: 0n } });
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
    });

    // Fire many concurrent grant() calls against the SAME tenant's credit account row. Each one
    // reads-then-updates that row inside a Serializable transaction, which is a textbook trigger
    // for Postgres serialization failures (SQLSTATE 40001 / Prisma P2034) under real concurrency.
    // Before the fix, prisma-billing.repository.js ran these with no retry, so any conflict here
    // would have surfaced as an unhandled rejection instead of being absorbed transparently.
    let transactionCalls = 0;
    prisma.$transaction = (...args) => { transactionCalls += 1; return originalTransaction(...args); };
    // Kept small deliberately: with enough simultaneous contenders on one row, a single
    // transaction can lose the SSI race 4 times in a row and legitimately exhaust the retry
    // cap (verified empirically) — that's a real capacity limit, not what this test checks.
    const grantCount = 4;
    const creditMicrosEach = 1_000_000n;
    const results = await Promise.all(Array.from({ length: grantCount }, (_, index) => billing.grant({
      tenantId: account.tenant.id, userId: account.user.id, creditMicros: creditMicrosEach,
      idempotencyKey: `retry-grant-${index}-${crypto.randomUUID()}`,
    })));
    prisma.$transaction = originalTransaction;

    assert.equal(results.length, grantCount);
    assert.ok(results.every((entry) => entry.type === 'grant'));
    const finalAccount = await prisma.creditAccount.findUnique({ where: { tenantId: account.tenant.id } });
    assert.equal(finalAccount.availableCreditMicros, creditMicrosEach * BigInt(grantCount));
    assert.equal(await prisma.creditLedgerEntry.count({ where: { tenantId: account.tenant.id, type: 'grant' } }), grantCount);
    // More $transaction invocations than grants proves the shared serializable() helper actually
    // caught at least one real conflict from Postgres and retried it to a clean success.
    assert.ok(transactionCalls > grantCount, `expected retries to push $transaction call count above ${grantCount}, got ${transactionCalls}`);

    // A genuine application error (not a serialization conflict) thrown inside the transaction
    // work function must propagate on the very first attempt, with no retry loop.
    let nonRetryableCalls = 0;
    prisma.$transaction = (...args) => { nonRetryableCalls += 1; return originalTransaction(...args); };
    await assert.rejects(() => billing.settle({
      reservationId: crypto.randomUUID(), generationRequestId: crypto.randomUUID(), usageEventId: crypto.randomUUID(),
      price: { id: crypto.randomUUID(), rateCard: {}, currency: 'USD' }, usage: {}, providerCostNanoUsd: 0n,
      calculation: {}, customerNanoUsd: 0n, finalCreditMicros: 0n,
    }), /Billing reservation not found/);
    prisma.$transaction = originalTransaction;
    assert.equal(nonRetryableCalls, 1);
  } finally {
    prisma.$transaction = originalTransaction;
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
      await db.creditLedgerEntry.deleteMany({ where: { tenantId: account.tenant.id } });
      await db.creditAccount.deleteMany({ where: { tenantId: account.tenant.id } });
      await db.workspace.deleteMany({ where: { id: account.tenant.id } });
      await db.user.deleteMany({ where: { id: account.user.id } });
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
    });
    await prisma.$disconnect();
  }
});
