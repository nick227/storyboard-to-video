require('dotenv').config();

const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');

// Syncs prod's three "only one active" billing-config singletons (credit rate, markup, welcome
// grant) to the same values already active in local/dev -- they were updated locally at some
// point but never replicated to Railway prod, which was still running the original placeholder
// values (1 cent/credit, 0% markup, 1000 welcome credits) from the initial billing migration.
// Deliberately narrow: touches ONLY these three singletons via the app's own versioned
// create+activate repository methods (never raw SQL, never touches ProviderPriceVersion,
// CreditPack, or any tenant's/global chargingEnabled flag). Idempotent -- safe to re-run, each
// step is a no-op if the target value is already active.
//
// Requires DATABASE_URL to point at the target DB explicitly (no implicit default) -- run as:
//   DATABASE_URL='<prod connection string>' node scripts/sync-prod-billing-config.js
const CREDIT_RATE = { versionKey: 'one-credit-equals-one-usd-v1', nanoUsdPerSiteCredit: 1_000_000_000n };
const MARKUP = { versionKey: 'production-markup-1pct-v1', name: 'Production 1% markup', markupBasisPoints: 100, fixedNanoUsd: 0n };
const WELCOME = { versionKey: 'welcome-2026-07-22', name: 'Welcome credits', creditMicros: 10_000_000n };

async function main() {
  const config = loadConfig();
  if (!config.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  try {
    const billing = new PrismaBillingRepository(prisma);
    const admin = new PrismaAdminRepository(prisma);
    const auditActorId = (actorUserId && await prisma.user.findUnique({ where: { id: actorUserId } })) ? actorUserId : null;
    const audit = async (event) => {
      if (!auditActorId) { console.log('(no valid admin user id found in this DB -- skipping audit log entry)'); return; }
      await admin.recordAudit({ actorUserId: auditActorId, ...event });
    };

    // 1. Credit rate
    let rate = await prisma.siteCreditRateVersion.findUnique({ where: { versionKey: CREDIT_RATE.versionKey } });
    if (!rate) rate = await billing.createCreditRateVersion({ ...CREDIT_RATE, active: false });
    if (!rate.active) {
      const before = await billing.activeCreditRate();
      rate = await billing.activateCreditRate(rate.id);
      await audit({ action: 'pricing.credit_rate_activated', targetType: 'site_credit_rate_version', targetId: rate.id, before: { versionKey: before?.versionKey, nanoUsdPerSiteCredit: before?.nanoUsdPerSiteCredit?.toString() }, after: { versionKey: rate.versionKey, nanoUsdPerSiteCredit: rate.nanoUsdPerSiteCredit.toString() }, reason: 'Sync prod credit rate to match local/dev ($1.00/credit) via scripts/sync-prod-billing-config.js, no admin browser session available.' });
      console.log(`activated credit rate ${rate.versionKey}: $${Number(rate.nanoUsdPerSiteCredit) / 1e9}/credit`);
    } else {
      console.log(`credit rate ${rate.versionKey} already active`);
    }

    // 2. Markup
    let markup = await prisma.markupPolicyVersion.findUnique({ where: { versionKey: MARKUP.versionKey } });
    if (!markup) markup = await billing.createMarkupVersion({ ...MARKUP, active: false });
    if (!markup.active) {
      const before = await billing.activeMarkup();
      markup = await billing.activateMarkup(markup.id);
      await audit({ action: 'pricing.markup_activated', targetType: 'markup_policy_version', targetId: markup.id, before: { versionKey: before?.versionKey, markupBasisPoints: before?.markupBasisPoints }, after: { versionKey: markup.versionKey, markupBasisPoints: markup.markupBasisPoints }, reason: 'Sync prod markup to match local/dev (1%) via scripts/sync-prod-billing-config.js, no admin browser session available.' });
      console.log(`activated markup ${markup.versionKey}: ${markup.markupBasisPoints / 100}%`);
    } else {
      console.log(`markup ${markup.versionKey} already active`);
    }

    // 3. Welcome grant
    let welcome = await prisma.welcomeCreditPolicyVersion.findUnique({ where: { versionKey: WELCOME.versionKey } });
    const activeWelcome = await prisma.welcomeCreditPolicyVersion.findFirst({ where: { active: true } });
    if (!welcome) {
      welcome = await billing.createWelcomeCreditPolicyVersion({ ...WELCOME, active: true, createdByAdminId: auditActorId });
      await audit({ action: 'pricing.welcome_credit_policy_created', targetType: 'welcome_credit_policy_version', targetId: welcome.id, before: activeWelcome ? { versionKey: activeWelcome.versionKey, creditMicros: activeWelcome.creditMicros.toString() } : null, after: { versionKey: welcome.versionKey, creditMicros: welcome.creditMicros.toString() }, reason: 'Sync prod welcome grant to match local/dev (10 credits) via scripts/sync-prod-billing-config.js, no admin browser session available.' });
      console.log(`created and activated welcome policy ${welcome.versionKey}: ${Number(welcome.creditMicros) / 1e6} credits`);
    } else if (welcome.active) {
      console.log(`welcome policy ${welcome.versionKey} already active`);
    } else {
      console.log(`welcome policy ${welcome.versionKey} exists but is not active (unexpected -- leaving as-is, not reactivating retired rows)`);
    }

    const [finalRate, finalMarkup, finalWelcome] = await Promise.all([
      billing.activeCreditRate(), billing.activeMarkup(), prisma.welcomeCreditPolicyVersion.findFirst({ where: { active: true } }),
    ]);
    console.log('--- final active state ---');
    console.log('credit rate:', finalRate.versionKey, `$${Number(finalRate.nanoUsdPerSiteCredit) / 1e9}/credit`);
    console.log('markup:', finalMarkup.versionKey, `${finalMarkup.markupBasisPoints / 100}%`);
    console.log('welcome:', finalWelcome.versionKey, `${Number(finalWelcome.creditMicros) / 1e6} credits`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
