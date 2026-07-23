require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

// Syncs prod's ProviderPriceVersion catalog to match local/dev's real, working policy. Prod only
// ever had the 5 rows an early migration (20260717111500_billing_foundation) inserts directly --
// the other 9 (minimax, piper x2, spark x4, ltx, whisperx) were only ever created in local/dev via
// one-off scripts (seed-observability-prices.js) that were never run against prod, and none of
// the 14 had billingTier set or the customer_metered ones promoted to billable (that was
// apply-prototype-billing-tiers.js, also local/dev only). This is the combined catch-up: create
// whatever's missing (exact field values copied from local/dev, verified against it directly),
// then tag billingTier and promote the 5 not-yet-billable customer_metered rows -- the same two
// steps apply-prototype-billing-tiers.js already did locally, folded into one idempotent script.
//
// Requires DATABASE_URL to point at the target DB explicitly:
//   DATABASE_URL='<prod connection string>' node scripts/sync-prod-provider-prices.js

const ROWS = [
  // customer_metered -- already exist in prod (from the foundation migration), just need tagging.
  { versionKey: 'openai-gpt-4.1-mini-2026-07-17', billingTier: 'customer_metered', billable: true, reconciledAtIfMissing: null },
  { versionKey: 'openai-gpt-image-1-2026-07-17', billingTier: 'customer_metered', billable: true, promoteNotes: 'Accepted under prototype billing policy (customer-metered; documented evidence sufficient), not a real dashboard check. Rate card matches OpenAI\'s published pricing. Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request req_2dbfa5b4721947aa8c5b6935aff52c27, 1024x1024 medium image, 17 input / 1056 output-image tokens, computed cost $0.042325.' },
  { versionKey: 'gemini-3.5-flash-2026-07-17', billingTier: 'customer_metered', billable: true, promoteNotes: 'Accepted under prototype billing policy (customer-metered; documented evidence sufficient), not a real dashboard check. Rate card matches Gemini\'s published pricing. Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request NZBgas2KCLCEz7IPi8y3wQo, 11 input / 505 output tokens, computed cost $0.0045615.' },
  { versionKey: 'gemini-3.1-flash-image-2026-07-17', billingTier: 'customer_metered', billable: true, promoteNotes: 'Accepted under prototype billing policy (customer-metered; documented evidence sufficient), not a real dashboard check. Rate card matches Gemini\'s published pricing. Real usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: request OJBgapWUCsLRz7IP3p_B-Qk, 1024x1024 medium image, 11 input / 1120 output-image tokens, computed cost $0.0680305.' },
  { versionKey: 'dezgo-text2image-2026-07-17', billingTier: 'customer_metered', billable: true, promoteNotes: 'Accepted under prototype billing policy (customer-metered; estimated evidence sufficient), not a real dashboard check. Matching account transaction charged $0.0151 on 2026-07-17. Additional usage evidence gathered 2026-07-22 via scripts/reconcile-batch-prices.js: 25 steps, 1 image, computed cost $0.015083333.' },

  // customer_metered -- missing entirely in prod, must be created (exact values from local/dev).
  {
    versionKey: 'minimax-hailuo-02-2026-observability-v1', create: true, billingTier: 'customer_metered', billable: true,
    provider: 'minimax', modality: 'video', model: 'MiniMax-Hailuo-02', currency: 'USD',
    rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 270000000 }, reservationNanoUsd: 300000000n,
    evidenceStatus: 'estimated', sourceReference: 'https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video',
    reconciliationNotes: 'Accepted under prototype billing policy (customer-metered; estimated evidence sufficient), not a real dashboard check. Real usage evidence gathered 2026-07-22 via scripts/reconcile-minimax-price.js: task id 422549537878267, 6s image-to-video clip, computed cost $0.27.',
  },

  // platform_overhead -- missing entirely in prod, must be created (exact values from local/dev).
  {
    versionKey: 'piper-local-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'piper', modality: 'audio', model: 'piper-local', currency: 'USD',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseUnits: 100, baseNanoUsd: 10000000 }, reservationNanoUsd: 15000000n,
    evidenceStatus: 'estimated', reconciliationNotes: 'Local Piper TTS estimate $0.01 per 100 seconds. Self-hosted/Modal service, no real reconciliation performed yet.',
  },
  {
    versionKey: 'piper-modal-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'piper', modality: 'audio', model: 'piper-modal', currency: 'USD',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseUnits: 100, baseNanoUsd: 10000000 }, reservationNanoUsd: 15000000n,
    evidenceStatus: 'estimated', reconciliationNotes: 'Modal-hosted Piper estimate $0.01 per 100 seconds. Self-hosted/Modal service, no real reconciliation performed yet.',
  },
  {
    versionKey: 'spark-tts-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'spark', modality: 'audio', model: 'spark-tts', currency: 'USD',
    rateCard: { type: 'linear_steps', usageKey: 'seconds', baseUnits: 100, baseNanoUsd: 50000000 }, reservationNanoUsd: 60000000n,
    evidenceStatus: 'estimated', reconciliationNotes: 'Spark TTS estimate $0.05 per 100 seconds. Self-hosted/Modal service, no real reconciliation performed yet.',
  },
  {
    versionKey: 'spark-voice-clone-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'spark', modality: 'audio', model: 'spark-voice-clone', currency: 'USD',
    rateCard: { type: 'flat', quantityKey: 'clones', nanoUsdPerUnit: 500000000 }, reservationNanoUsd: 600000000n,
    evidenceStatus: 'estimated', reconciliationNotes: 'Voice clone GPU job estimate ~$0.50/clone. Self-hosted/Modal service, no real reconciliation performed yet.',
  },
  {
    versionKey: 'spark-preflight-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'spark', modality: 'audio', model: 'spark-preflight', currency: 'USD',
    rateCard: { type: 'flat', nanoUsdPerUnit: 0 }, reservationNanoUsd: 0n,
    evidenceStatus: 'estimated', reconciliationNotes: 'Health-check ping; negligible cost.',
  },
  {
    versionKey: 'spark-reference-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'spark', modality: 'audio', model: 'spark-reference', currency: 'USD',
    rateCard: { type: 'flat', nanoUsdPerUnit: 0 }, reservationNanoUsd: 0n,
    evidenceStatus: 'estimated', reconciliationNotes: 'Reference audio read; negligible cost.',
  },
  {
    versionKey: 'ltx-video-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'ltx', modality: 'video', model: 'ltx-video', currency: 'USD',
    rateCard: { type: 'flat', quantityKey: 'videos', nanoUsdPerUnit: 15000000 }, reservationNanoUsd: 20000000n,
    evidenceStatus: 'estimated', reconciliationNotes: 'Self-hosted LTX estimate ~$0.015/generation. Self-hosted/Modal service, no real reconciliation performed yet.',
  },
  {
    versionKey: 'whisperx-forced-alignment-observability-v1', create: true, billingTier: 'platform_overhead', billable: false,
    provider: 'whisperx', modality: 'alignment', model: 'whisperx-forced-alignment', currency: 'USD',
    rateCard: { type: 'flat', nanoUsdPerUnit: 2000000 }, reservationNanoUsd: 3000000n,
    evidenceStatus: 'estimated', reconciliationNotes: 'WhisperX forced-alignment estimate ~$0.002/call. Self-hosted/Modal service, no real reconciliation performed yet.',
  },
];

async function main() {
  const config = loadConfig();
  if (!config.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const billing = new PrismaBillingRepository(prisma);
    const admin = new PrismaAdminRepository(prisma);
    const auditActorId = (actorUserId && await prisma.user.findUnique({ where: { id: actorUserId } })) ? actorUserId : null;
    const audit = async (event) => { if (auditActorId) await admin.recordAudit({ actorUserId: auditActorId, ...event }); };

    for (const row of ROWS) {
      let price = await prisma.providerPriceVersion.findUnique({ where: { versionKey: row.versionKey } });

      if (!price && row.create) {
        // Created inactive + not-yet-billable first, then activated/promoted via configurePrice
        // below -- createPriceVersion's own guard requires billingTier=customer_metered +
        // reconciledAt before it will ever accept billable:true.
        price = await billing.createPriceVersion({
          versionKey: row.versionKey, provider: row.provider, modality: row.modality, model: row.model, currency: row.currency,
          rateCard: row.rateCard, reservationNanoUsd: row.reservationNanoUsd, evidenceStatus: row.evidenceStatus,
          reconciliationNotes: row.reconciliationNotes, sourceReference: row.sourceReference || null,
          billingTier: null, billable: false, active: false,
        });
        price = await billing.configurePrice(price.id, { active: true });
        await audit({ action: 'pricing.provider_version_created', targetType: 'provider_price_version', targetId: price.id, after: { versionKey: price.versionKey, provider: price.provider, model: price.model }, reason: 'Created in prod to match local/dev catalog via scripts/sync-prod-provider-prices.js, no admin browser session available.' });
        console.log(`created ${price.versionKey}`);
      } else if (!price) {
        console.log(`MISSING and not marked create:true -- skipping: ${row.versionKey}`);
        continue;
      } else {
        console.log(`already exists: ${row.versionKey}`);
      }

      if (price.billingTier !== row.billingTier) {
        const before = { billingTier: price.billingTier };
        price = await billing.configurePrice(price.id, { billingTier: row.billingTier });
        await audit({ action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: price.id, before, after: { billingTier: price.billingTier }, reason: 'Tagged billingTier to match local/dev via scripts/sync-prod-provider-prices.js, no admin browser session available.' });
        console.log(`  tagged billingTier=${price.billingTier}`);
      }

      if (row.billable && !price.billable) {
        const before = { billable: price.billable, reconciledAt: price.reconciledAt };
        price = await billing.configurePrice(price.id, { billable: true, reconciledAt: new Date(), reconciliationNotes: row.promoteNotes || price.reconciliationNotes });
        await audit({ action: 'pricing.provider_version_configured', targetType: 'provider_price_version', targetId: price.id, before, after: { billable: price.billable, reconciledAt: price.reconciledAt }, reason: 'Promoted to billable:true to match local/dev via scripts/sync-prod-provider-prices.js, no admin browser session available.' });
        console.log(`  promoted billable=true`);
      } else if (!row.billable && price.billable) {
        console.log(`  WARNING: ${row.versionKey} is billable:true but policy says it shouldn't be -- not touching it (never auto-downgrade); investigate manually.`);
      } else {
        console.log(`  billable already correct: ${price.billable}`);
      }
    }

    const final = await prisma.providerPriceVersion.findMany({ where: { active: true }, select: { versionKey: true, provider: true, modality: true, model: true, billingTier: true, billable: true } });
    console.log('\n--- final active catalog ---');
    console.log(JSON.stringify(final, null, 2));
    console.log(`\ntotal active: ${final.length}, customer_metered: ${final.filter((r) => r.billingTier === 'customer_metered').length}, platform_overhead: ${final.filter((r) => r.billingTier === 'platform_overhead').length}, billable: ${final.filter((r) => r.billable).length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
