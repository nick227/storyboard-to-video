const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaIdentityRepository } = require('../src/storage/prisma-identity.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

const enabled = process.env.PRISMA_INTEGRATION_TESTS === '1';

test('admin repository records sales atomically, protects roles, revokes disabled sessions, and preserves audit history', { skip: !enabled }, async () => {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const identity = new PrismaIdentityRepository(prisma);
  const admin = new PrismaAdminRepository(prisma);
  const actor = await identity.createUserWithPersonalWorkspace({ email: `admin-actor-${crypto.randomUUID()}@example.com`, displayName: 'Admin Audit Actor', passwordHash: 'test-only' });
  const customer = await identity.createUserWithPersonalWorkspace({ email: `admin-customer-${crypto.randomUUID()}@example.com`, displayName: 'Admin Audit Customer', passwordHash: 'test-only' });
  await prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
    await db.creditLedgerEntry.deleteMany({ where: { tenantId: { in: [actor.tenant.id, customer.tenant.id] }, type: 'welcome_grant' } });
    await db.creditAccount.deleteMany({ where: { tenantId: { in: [actor.tenant.id, customer.tenant.id] } } });
    await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
  });
  await prisma.user.update({ where: { id: actor.user.id }, data: { platformRole: 'super_admin' } });
  try {
    await identity.createSession({ tokenHash: crypto.randomBytes(32).toString('hex'), userId: customer.user.id, tenantId: customer.tenant.id, expiresAt: new Date(Date.now() + 60_000) });
    const key = `manual-sale:${crypto.randomUUID()}`;
    const payment = `manual-payment:${crypto.randomUUID()}`;
    const sale = await admin.recordSale({
      tenantId: customer.tenant.id, customerUserId: customer.user.id, cashAmountNanoUsd: 25000000000n,
      creditsPurchasedMicros: 300000000n, currency: 'USD', paymentProvider: 'manual', externalPaymentId: payment,
      occurredAt: new Date(), notes: 'Controlled internal sale', actorUserId: actor.user.id, idempotencyKey: key, requestId: 'admin-test-sale',
    });
    assert.equal(sale.reused, false);
    assert.equal((await prisma.creditAccount.findUnique({ where: { tenantId: customer.tenant.id } })).availableCreditMicros, 300000000n);
    assert.equal((await admin.recordSale({ tenantId: customer.tenant.id, customerUserId: customer.user.id, cashAmountNanoUsd: 25000000000n, creditsPurchasedMicros: 300000000n, currency: 'USD', paymentProvider: 'manual', externalPaymentId: payment, occurredAt: new Date(), actorUserId: actor.user.id, idempotencyKey: key })).reused, true);
    assert.equal(await prisma.creditSale.count({ where: { tenantId: customer.tenant.id } }), 1);
    assert.equal(await prisma.creditLedgerEntry.count({ where: { tenantId: customer.tenant.id, type: 'sale_grant' } }), 1);

    const promoted = await admin.setPlatformRole({ userId: customer.user.id, platformRole: 'admin', actorUserId: actor.user.id, actorRole: 'super_admin', reason: 'Operations coverage', requestId: 'admin-test-role' });
    assert.equal(promoted.platformRole, 'admin');
    await assert.rejects(() => admin.setPlatformRole({ userId: actor.user.id, platformRole: 'user', actorUserId: actor.user.id, actorRole: 'super_admin', reason: 'invalid' }), (error) => error.code === 'SELF_ROLE_CHANGE_FORBIDDEN');
    await assert.rejects(() => admin.setPlatformRole({ userId: customer.user.id, platformRole: 'super_admin', actorUserId: customer.user.id, actorRole: 'admin', reason: 'invalid' }), (error) => ['SUPER_ADMIN_REQUIRED', 'SELF_ROLE_CHANGE_FORBIDDEN'].includes(error.code));

    const disabled = await admin.setUserStatus({ userId: customer.user.id, status: 'disabled', actorUserId: actor.user.id, reason: 'Support review', requestId: 'admin-test-disable' });
    assert.equal(disabled.status, 'disabled');
    assert.equal(await prisma.session.count({ where: { userId: customer.user.id } }), 0);
    assert.equal((await prisma.creditAccount.findUnique({ where: { tenantId: customer.tenant.id } })).chargingEnabled, false);

    const overview = await admin.overview();
    assert.ok((overview.sales._sum.cashAmountNanoUsd || 0n) >= 25000000000n);
    const users = await admin.listUsers({ search: customer.user.email });
    assert.equal(users[0].memberships[0].workspace.creditAccount.availableCreditMicros, 300000000n);
    const actions = (await admin.listAudit({ limit: 20 })).filter((event) => [actor.user.id, customer.user.id].includes(event.actorUserId)).map((event) => event.action);
    assert.ok(actions.includes('sale.recorded'));
    assert.ok(actions.includes('user.role_changed'));
    assert.ok(actions.includes('user.disabled'));

    await assert.rejects(() => prisma.creditSale.update({ where: { id: sale.sale.id }, data: { notes: 'changed' } }), /immutable|append-only/);
    const audit = await prisma.adminAuditEvent.findFirst({ where: { actorUserId: actor.user.id } });
    await assert.rejects(() => prisma.adminAuditEvent.update({ where: { id: audit.id }, data: { reason: 'changed' } }), /append-only/);
  } finally {
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_sales DISABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE admin_audit_events DISABLE TRIGGER USER');
      await db.adminAuditEvent.deleteMany({ where: { actorUserId: actor.user.id } });
      await db.creditSale.deleteMany({ where: { tenantId: customer.tenant.id } });
      await db.creditLedgerEntry.deleteMany({ where: { tenantId: { in: [actor.tenant.id, customer.tenant.id] } } });
      await db.creditAccount.deleteMany({ where: { tenantId: { in: [actor.tenant.id, customer.tenant.id] } } });
      await db.workspace.deleteMany({ where: { id: { in: [actor.tenant.id, customer.tenant.id] } } });
      await db.user.deleteMany({ where: { id: { in: [actor.user.id, customer.user.id] } } });
      await db.$executeRawUnsafe('ALTER TABLE admin_audit_events ENABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_sales ENABLE TRIGGER USER');
      await db.$executeRawUnsafe('ALTER TABLE credit_ledger_entries ENABLE TRIGGER USER');
    });
    await prisma.$disconnect();
  }
});
