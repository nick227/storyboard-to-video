require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

// Applies the prototype provider-cost billing policy (see plans/goofy-crunching-cascade.md):
// customer-metered providers (external APIs with an obvious cost model) can become billable on
// documented/estimated evidence; platform-overhead providers (self-hosted/Modal services) are
// tagged so the repository-level guard hard-blocks billable:true for them regardless of evidence.
const CUSTOMER_METERED_KEYS = [
  'openai-gpt-4.1-mini-2026-07-17',
  'openai-gpt-image-1-2026-07-17',
  'gemini-3.5-flash-2026-07-17',
  'gemini-3.1-flash-image-2026-07-17',
  'dezgo-text2image-2026-07-17',
  'dezgo-flux-1-schnell-2026-07-22',
  'minimax-hailuo-02-2026-observability-v1',
];

const PLATFORM_OVERHEAD_KEYS = [
  'piper-local-observability-v1',
  'piper-modal-observability-v1',
  'spark-tts-observability-v1',
  'spark-voice-clone-observability-v1',
  'spark-preflight-observability-v1',
  'spark-reference-observability-v1',
  'ltx-video-observability-v1',
  'whisperx-forced-alignment-observability-v1',
];

// The 5 customer-metered prices not already billable, promoted on their existing (real, but not
// dashboard-reconciled) evidence gathered earlier this session -- accepted under the new
// prototype policy rather than a real provider dashboard check.
const NEWLY_BILLABLE_NOTES = {
  'openai-gpt-image-1-2026-07-17': 'Accepted under prototype billing policy (customer-metered; documented evidence sufficient), not a real dashboard check. Rate card matches OpenAI\'s published pricing. Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request req_2dbfa5b4721947aa8c5b6935aff52c27, 1024x1024 medium image, 17 input / 1056 output-image tokens, computed cost $0.042325.',
  'gemini-3.5-flash-2026-07-17': 'Accepted under prototype billing policy (customer-metered; documented evidence sufficient), not a real dashboard check. Rate card matches Gemini\'s published pricing. Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request NZBgas2KCLCEz7IPi8y3wQo, 11 input / 505 output tokens, computed cost $0.0045615.',
  'gemini-3.1-flash-image-2026-07-17': 'Accepted under prototype billing policy (customer-metered; documented evidence sufficient), not a real dashboard check. Rate card matches Gemini\'s published pricing. Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request OJBgapWUCsLRz7IP3p_B-Qk, 1024x1024 medium image, 11 input / 1120 output-image tokens, computed cost $0.0680305.',
  'dezgo-text2image-2026-07-17': 'Accepted under prototype billing policy (customer-metered; estimated evidence sufficient), not a real dashboard check. Matching account transaction charged $0.0151 on 2026-07-17. Additional usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: 25 steps, 1 image, computed cost $0.015083333.',
  'minimax-hailuo-02-2026-observability-v1': 'Accepted under prototype billing policy (customer-metered; estimated evidence sufficient), not a real dashboard check. Real usage evidence gathered 2026-07-22 via scripts/reconcile-minimax-price.js: task id 422549537878267, 6s image-to-video clip, computed cost $0.27.',
};

async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const billingRepository = new PrismaBillingRepository(prisma);
    const adminRepository = new PrismaAdminRepository(prisma);

    async function setTier(versionKey, billingTier) {
      const price = await prisma.providerPriceVersion.findUnique({ where: { versionKey } });
      if (!price) { console.log(`skip (not found): ${versionKey}`); return null; }
      if (price.billingTier === billingTier) { console.log(`already tagged: ${versionKey} -> ${billingTier}`); return price; }
      const before = { billingTier: price.billingTier };
      const updated = await billingRepository.configurePrice(price.id, { billingTier });
      if (adminRepository && actorUserId) {
        await adminRepository.recordAudit({
          actorUserId, action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: updated.id,
          before, after: { billingTier: updated.billingTier },
          reason: 'Tagged with billingTier under the new prototype provider-cost billing policy via scripts/apply-prototype-billing-tiers.js, no admin browser session available.',
        });
      }
      console.log(`tagged ${updated.versionKey}: billingTier=${updated.billingTier}`);
      return updated;
    }

    for (const versionKey of CUSTOMER_METERED_KEYS) await setTier(versionKey, 'customer_metered');
    for (const versionKey of PLATFORM_OVERHEAD_KEYS) await setTier(versionKey, 'platform_overhead');

    const today = new Date();
    for (const [versionKey, notes] of Object.entries(NEWLY_BILLABLE_NOTES)) {
      const price = await prisma.providerPriceVersion.findUnique({ where: { versionKey } });
      if (!price) { console.log(`skip billable promotion (not found): ${versionKey}`); continue; }
      if (price.billable) { console.log(`already billable: ${versionKey}`); continue; }
      const before = { billable: price.billable, reconciledAt: price.reconciledAt, reconciliationNotes: price.reconciliationNotes };
      const updated = await billingRepository.configurePrice(price.id, {
        billable: true, reconciledAt: today, reconciliationNotes: notes,
      });
      if (adminRepository && actorUserId) {
        await adminRepository.recordAudit({
          actorUserId, action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: updated.id,
          before, after: { billable: updated.billable, reconciledAt: updated.reconciledAt },
          reason: 'Promoted to billable:true under the new prototype provider-cost billing policy via scripts/apply-prototype-billing-tiers.js, no admin browser session available.',
        });
      }
      console.log(`promoted ${updated.versionKey}: billable=${updated.billable} reconciledAt=${updated.reconciledAt?.toISOString()}`);
    }

    const rows = await prisma.providerPriceVersion.findMany({ where: { active: true }, select: { versionKey: true, billingTier: true, billable: true } });
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
