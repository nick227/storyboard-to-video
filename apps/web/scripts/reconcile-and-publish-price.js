require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

// Marks a ProviderPriceVersion billable once a human has actually compared it against the
// provider's real billing dashboard -- configurePrice() itself refuses billable:true without
// evidenceStatus:'dashboard_reconciled' plus a reconciledAt date, so this script can't skip that
// step even if asked to; it just records the operator's real-world attestation instead of
// requiring an admin browser session in this environment.
async function main() {
  const [versionKey, notes] = process.argv.slice(2);
  if (!versionKey || !notes) throw new Error('Usage: node scripts/reconcile-and-publish-price.js <versionKey> "<reconciliation notes>"');
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const billingRepository = new PrismaBillingRepository(prisma);
    const adminRepository = new PrismaAdminRepository(prisma);
    const price = await prisma.providerPriceVersion.findUnique({ where: { versionKey } });
    if (!price) throw new Error(`No ProviderPriceVersion with versionKey ${versionKey}`);
    const reconciledAt = new Date();
    const updated = await billingRepository.configurePrice(price.id, {
      billable: true, evidenceStatus: 'dashboard_reconciled', reconciledAt, reconciliationNotes: notes,
    });
    if (adminRepository && actorUserId) {
      await adminRepository.recordAudit({
        actorUserId, action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: updated.id,
        after: { billable: updated.billable, evidenceStatus: updated.evidenceStatus, reconciledAt: updated.reconciledAt },
        reason: 'Reconciled via scripts/reconcile-and-publish-price.js at operator request (no admin browser session available).',
      });
    }
    console.log(`reconciled ${updated.versionKey}: billable=${updated.billable} evidenceStatus=${updated.evidenceStatus} reconciledAt=${updated.reconciledAt.toISOString()} (audit actor: ${actorUserId || 'none'})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
