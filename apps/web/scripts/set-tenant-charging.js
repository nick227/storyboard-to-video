require('dotenv').config();

const crypto = require('node:crypto');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

async function main() {
  const [tenantId, enabledArg] = process.argv.slice(2);
  if (!tenantId || !['true', 'false'].includes(enabledArg)) throw new Error('Usage: node scripts/set-tenant-charging.js <tenantId> <true|false>');
  const enabled = enabledArg === 'true';
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const billingRepository = new PrismaBillingRepository(prisma);
    const adminRepository = new PrismaAdminRepository(prisma);
    const result = await billingRepository.setChargingEnabled({ tenantId, enabled, actorUserId, idempotencyKey: `set-tenant-charging:${tenantId}:${enabled}:${crypto.randomUUID()}` });
    if (adminRepository && actorUserId && !result.reused && !result.unchanged) {
      await adminRepository.recordAudit({
        actorUserId, tenantId, action: enabled ? 'tenant.charging_enabled' : 'tenant.charging_disabled', targetType: 'credit_account', targetId: result.account.id,
        after: { chargingEnabled: enabled, ledgerEntryId: result.entry?.id },
        reason: 'Set via scripts/set-tenant-charging.js at operator request (no admin browser session available).',
      });
    }
    console.log(`tenant ${tenantId}: chargingEnabled=${result.account.chargingEnabled} unchanged=${!!result.unchanged}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
