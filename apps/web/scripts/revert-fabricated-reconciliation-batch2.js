require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

// Same correction as scripts/revert-fabricated-reconciliation.js, extended to the remaining 9
// prices scripts/seed-canonical-pricing.js --apply also bulk-stamped dashboard_reconciled: true
// with a hardcoded date. These are the Modal-hosted/self-hosted services (MiniMax, LTX, Piper,
// Spark, WhisperX) -- all were seeded as evidenceStatus:'estimated' originally
// (scripts/seed-observability-prices.js) and none have had any real reconciliation since.
const VERSION_KEYS = [
  'minimax-hailuo-02-2026-observability-v1',
  'ltx-video-observability-v1',
  'piper-local-observability-v1',
  'piper-modal-observability-v1',
  'spark-tts-observability-v1',
  'spark-voice-clone-observability-v1',
  'spark-preflight-observability-v1',
  'spark-reference-observability-v1',
  'whisperx-forced-alignment-observability-v1',
];

async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const billingRepository = new PrismaBillingRepository(prisma);
    const adminRepository = new PrismaAdminRepository(prisma);
    for (const versionKey of VERSION_KEYS) {
      const price = await prisma.providerPriceVersion.findUnique({ where: { versionKey } });
      if (!price) { console.log(`skip (not found): ${versionKey}`); continue; }
      const before = { billable: price.billable, evidenceStatus: price.evidenceStatus, reconciledAt: price.reconciledAt };
      const notes = `${price.reconciliationNotes || ''} [Reverted from an incorrectly bulk-applied dashboard_reconciled stamp (scripts/seed-canonical-pricing.js) -- this is a self-hosted/Modal service with no real reconciliation performed yet.]`;
      const updated = await billingRepository.configurePrice(price.id, {
        billable: false, evidenceStatus: 'estimated', reconciledAt: null, reconciliationNotes: notes,
      });
      if (adminRepository && actorUserId) {
        await adminRepository.recordAudit({
          actorUserId, action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: updated.id,
          before, after: { billable: updated.billable, evidenceStatus: updated.evidenceStatus, reconciledAt: updated.reconciledAt },
          reason: 'Reverted a fabricated bulk dashboard_reconciled stamp back to honest (estimated, non-billable) evidence via scripts/revert-fabricated-reconciliation-batch2.js, at operator request.',
        });
      }
      console.log(`corrected ${updated.versionKey}: billable=${updated.billable} evidenceStatus=${updated.evidenceStatus}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
