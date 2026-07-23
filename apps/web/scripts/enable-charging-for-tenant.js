require('dotenv').config();

const crypto = require('node:crypto');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

// Enables CreditAccount.chargingEnabled for exactly one real, named tenant -- via the app's own
// setChargingEnabled method (the same one the admin console's "Allow charging" button calls), so
// it goes through the ledger (a charging_enabled entry) and audit log like any real admin action,
// never a raw update. Deliberately per-tenant and explicit, not "enable for everyone" -- launch
// guard per the pre-flight snapshot: 10 of 11 tenants in prod have clearly synthetic/test emails.
//
// Usage: DATABASE_URL='<target>' node scripts/enable-charging-for-tenant.js <tenantId>
async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) throw new Error('Usage: node scripts/enable-charging-for-tenant.js <tenantId>');
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  try {
    const billing = new PrismaBillingRepository(prisma);
    const admin = new PrismaAdminRepository(prisma);
    const tenant = await prisma.workspace.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error(`Workspace ${tenantId} not found`);
    const owner = await prisma.membership.findFirst({ where: { tenantId, role: 'owner' }, include: { user: { select: { id: true, email: true } } } });
    console.log(`Enabling charging for tenant ${tenantId} (${tenant.name || 'unnamed'}), owner: ${owner?.user?.email || 'unknown'}`);

    const actorUserId = owner?.user?.id || String(config.env.ADMIN_OWNER_IDS || '').split(',')[0]?.trim() || null;
    const result = await billing.setChargingEnabled({
      tenantId, enabled: true, actorUserId, idempotencyKey: `enable-charging-launch:${tenantId}`,
    });
    if (result.reused) console.log('idempotency key already used -- no-op (already processed)');
    else if (result.unchanged) console.log('charging was already enabled for this tenant -- no-op');
    else {
      console.log(`charging enabled. ledger entry: ${result.entry.id}`);
      await admin.recordAudit({
        actorUserId, tenantId, action: 'tenant.charging_enabled', targetType: 'credit_account', targetId: result.account.id,
        after: { chargingEnabled: true, ledgerEntryId: result.entry.id },
        reason: 'Live-billing launch: enabling charging for this one real tenant via scripts/enable-charging-for-tenant.js, per explicit launch-guard instructions (only real, non-test tenants). No admin browser session available.',
      });
    }
    const final = await prisma.creditAccount.findUnique({ where: { tenantId } });
    console.log('final state:', { chargingEnabled: final.chargingEnabled, availableCreditMicros: final.availableCreditMicros.toString() });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
