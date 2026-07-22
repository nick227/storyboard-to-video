require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

// scripts/seed-canonical-pricing.js --apply stamped these four rows evidenceStatus:
// 'dashboard_reconciled' (and billable:true) in bulk, with a hardcoded date -- not a real
// per-price attestation against each provider's actual billing dashboard. This restores each to
// the honest evidence tier it actually had, which also correctly un-flips billable (configurePrice
// itself refuses billable:true without real dashboard_reconciled evidence). Real usage evidence
// gathered today (scripts/reconcile-batch-prices.js -- real request IDs, real token/step counts,
// real computed cost) is preserved in the notes so that work isn't lost, clearly labeled as
// pending an actual dashboard cross-check.
const CORRECTIONS = [
  {
    versionKey: 'gemini-3.5-flash-2026-07-17', evidenceStatus: 'documented', reconciledAt: null,
    reconciliationNotes: 'Reverted from an incorrectly bulk-applied dashboard_reconciled stamp (scripts/seed-canonical-pricing.js). Rate card matches Gemini\'s published pricing (sourceReference). Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request NZBgas2KCLCEz7IPi8y3wQo, 11 input / 505 output tokens, computed cost $0.0045615 -- pending an actual Google AI/Cloud billing dashboard cross-check.',
  },
  {
    versionKey: 'gemini-3.1-flash-image-2026-07-17', evidenceStatus: 'documented', reconciledAt: null,
    reconciliationNotes: 'Reverted from an incorrectly bulk-applied dashboard_reconciled stamp (scripts/seed-canonical-pricing.js). Rate card matches Gemini\'s published pricing (sourceReference). Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request OJBgapWUCsLRz7IP3p_B-Qk, 1024x1024 medium image, 11 input / 1120 output-image tokens, computed cost $0.0680305 -- pending an actual Google AI/Cloud billing dashboard cross-check.',
  },
  {
    versionKey: 'openai-gpt-image-1-2026-07-17', evidenceStatus: 'documented', reconciledAt: null,
    reconciliationNotes: 'Reverted from an incorrectly bulk-applied dashboard_reconciled stamp (scripts/seed-canonical-pricing.js). Rate card matches OpenAI\'s published pricing (sourceReference). Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request req_2dbfa5b4721947aa8c5b6935aff52c27, 1024x1024 medium image, 17 input / 1056 output-image tokens, computed cost $0.042325 -- pending an actual OpenAI usage dashboard cross-check.',
  },
  {
    versionKey: 'dezgo-text2image-2026-07-17', evidenceStatus: 'estimated', reconciledAt: new Date('2026-07-17T10:51:36.000Z'),
    reconciliationNotes: 'Reverted from an incorrectly bulk-applied dashboard_reconciled stamp (scripts/seed-canonical-pricing.js). Restored to its prior, more honest evidence: matching account transaction charged $0.0151 on 2026-07-17; no provider request ID was available so the formula remains estimated. Additional usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: 25 steps, 1 image, computed cost $0.015083333 -- pending a full Dezgo dashboard cross-check.',
  },
];

async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const billingRepository = new PrismaBillingRepository(prisma);
    const adminRepository = new PrismaAdminRepository(prisma);
    for (const correction of CORRECTIONS) {
      const price = await prisma.providerPriceVersion.findUnique({ where: { versionKey: correction.versionKey } });
      if (!price) { console.log(`skip (not found): ${correction.versionKey}`); continue; }
      const before = { billable: price.billable, evidenceStatus: price.evidenceStatus, reconciledAt: price.reconciledAt };
      const updated = await billingRepository.configurePrice(price.id, {
        billable: false, evidenceStatus: correction.evidenceStatus, reconciledAt: correction.reconciledAt, reconciliationNotes: correction.reconciliationNotes,
      });
      if (adminRepository && actorUserId) {
        await adminRepository.recordAudit({
          actorUserId, action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: updated.id,
          before, after: { billable: updated.billable, evidenceStatus: updated.evidenceStatus, reconciledAt: updated.reconciledAt },
          reason: 'Reverted a fabricated bulk dashboard_reconciled stamp back to honest evidence via scripts/revert-fabricated-reconciliation.js, at operator request.',
        });
      }
      console.log(`corrected ${updated.versionKey}: billable=${updated.billable} evidenceStatus=${updated.evidenceStatus} reconciledAt=${updated.reconciledAt ? updated.reconciledAt.toISOString() : null}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
