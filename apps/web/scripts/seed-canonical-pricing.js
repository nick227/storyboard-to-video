require('dotenv').config();

const crypto = require('node:crypto');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { CANONICAL_PRICES, RECONCILED_AT, priceKey } = require('../pricing/canonical-prices');

const MARKUP_VERSION_KEY = 'production-markup-1pct-v1';
const MARKUP_BASIS_POINTS = 100; // 1%
const CREDIT_RATE_VERSION_KEY = 'one-credit-equals-one-usd-v1';
const NANO_USD_PER_SITE_CREDIT = 1_000_000_000n; // $1.00 per site credit
const WELCOME_VERSION_KEY = 'welcome-10-credits-v1';
const WELCOME_CREDIT_MICROS = 10_000_000n; // 10 site credits

function parseArgs(argv) {
  const args = { apply: false, enableCharging: true };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--no-charging') args.enableCharging = false;
    else throw new Error('Usage: node scripts/seed-canonical-pricing.js [--apply] [--no-charging]');
  }
  return args;
}

async function ensureSiteEconomics(prisma, billingRepo, apply) {
  const plan = { markup: null, creditRate: null, welcome: null };

  let markup = await prisma.markupPolicyVersion.findFirst({ where: { active: true } });
  if (apply && (!markup || markup.markupBasisPoints !== MARKUP_BASIS_POINTS)) {
    markup = await billingRepo.createMarkupVersion({
      versionKey: markup?.markupBasisPoints === MARKUP_BASIS_POINTS ? MARKUP_VERSION_KEY : `${MARKUP_VERSION_KEY}-${Date.now()}`,
      name: 'Production 1% markup',
      markupBasisPoints: MARKUP_BASIS_POINTS,
      fixedNanoUsd: 0n,
      active: false,
    });
    markup = await billingRepo.activateMarkup(markup.id);
  }
  plan.markup = markup
    ? { versionKey: markup.versionKey, percent: Number(markup.markupBasisPoints) / 100, active: markup.active }
    : { targetPercent: 1 };

  let creditRate = await prisma.siteCreditRateVersion.findUnique({ where: { versionKey: CREDIT_RATE_VERSION_KEY } });
  if (!creditRate && apply) {
    creditRate = await billingRepo.createCreditRateVersion({ versionKey: CREDIT_RATE_VERSION_KEY, nanoUsdPerSiteCredit: NANO_USD_PER_SITE_CREDIT, active: false });
  }
  if (creditRate && apply && !creditRate.active) creditRate = await billingRepo.activateCreditRate(creditRate.id);
  plan.creditRate = creditRate
    ? { versionKey: creditRate.versionKey, usdPerCredit: Number(creditRate.nanoUsdPerSiteCredit) / 1e9, active: creditRate.active }
    : { targetUsdPerCredit: 1 };

  const activeWelcome = await prisma.welcomeCreditPolicyVersion.findFirst({ where: { active: true } });
  if (apply && (!activeWelcome || activeWelcome.creditMicros !== WELCOME_CREDIT_MICROS)) {
    welcome = await billingRepo.createWelcomeCreditPolicyVersion({
      versionKey: activeWelcome ? `${WELCOME_VERSION_KEY}-${Date.now()}` : WELCOME_VERSION_KEY,
      name: '10 welcome credits',
      creditMicros: WELCOME_CREDIT_MICROS,
      active: true,
    });
  } else {
    welcome = activeWelcome || welcome;
  }
  plan.welcome = welcome || activeWelcome
    ? { versionKey: (welcome || activeWelcome).versionKey, credits: Number((welcome || activeWelcome).creditMicros) / 1e6, active: true }
    : { targetCredits: 10 };

  return plan;
}

async function seedCanonicalPrices(prisma, billingRepo, apply) {
  const canonicalKeys = new Set(CANONICAL_PRICES.map(priceKey));
  const existing = await prisma.providerPriceVersion.findMany();
  const results = { deactivated: 0, created: 0, configured: 0, canonical: [] };

  for (const row of existing) {
    if (canonicalKeys.has(priceKey(row)) || !row.active) continue;
    if (!apply) { results.deactivated += 1; continue; }
    await billingRepo.configurePrice(row.id, { active: false });
    results.deactivated += 1;
  }

  for (const canonical of CANONICAL_PRICES) {
    const key = priceKey(canonical);
    let row = await prisma.providerPriceVersion.findUnique({ where: { versionKey: canonical.versionKey } });
    if (!row && apply) {
      row = await billingRepo.createPriceVersion({
        versionKey: canonical.versionKey,
        provider: canonical.provider,
        modality: canonical.modality,
        model: canonical.model,
        currency: 'USD',
        rateCard: canonical.rateCard,
        reservationNanoUsd: canonical.reservationNanoUsd,
        evidenceStatus: 'dashboard_reconciled',
        reconciledAt: RECONCILED_AT,
        reconciliationNotes: canonical.reconciliationNotes,
        sourceReference: canonical.sourceReference || null,
        billable: false,
        active: false,
      });
      results.created += 1;
    }
    if (!row) {
      results.canonical.push({ key, status: 'missing', versionKey: canonical.versionKey });
      continue;
    }
    if (!apply) {
      results.canonical.push({ key, status: 'dry-run', id: row.id, active: row.active, billable: row.billable, reservationNanoUsd: row.reservationNanoUsd.toString() });
      continue;
    }
    row = await billingRepo.configurePrice(row.id, {
      active: true,
      billable: true,
      evidenceStatus: 'dashboard_reconciled',
      reconciledAt: RECONCILED_AT,
      reconciliationNotes: canonical.reconciliationNotes,
    });
    results.configured += 1;
    results.canonical.push({ key, status: 'active', id: row.id, billable: row.billable, reservationNanoUsd: row.reservationNanoUsd.toString() });
  }

  return results;
}

async function enableTenantCharging(prisma, apply) {
  if (!apply) {
    const count = await prisma.creditAccount.count({ where: { chargingEnabled: false } });
    return { dryRun: true, accountsToEnable: count };
  }
  const updated = await prisma.creditAccount.updateMany({ where: { chargingEnabled: false }, data: { chargingEnabled: true, chargingChangedAt: new Date() } });
  return { accountsEnabled: updated.count };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const billingRepo = new PrismaBillingRepository(prisma);

  try {
    const before = {
      totalPrices: await prisma.providerPriceVersion.count(),
      activePrices: await prisma.providerPriceVersion.count({ where: { active: true } }),
      gpt4oActive: await prisma.providerPriceVersion.count({ where: { model: 'gpt-4o', active: true } }),
    };

    const plan = {
      mode: args.apply ? 'apply' : 'dry-run',
      before,
      siteEconomics: await ensureSiteEconomics(prisma, billingRepo, args.apply),
      prices: await seedCanonicalPrices(prisma, billingRepo, args.apply),
      charging: args.enableCharging ? await enableTenantCharging(prisma, args.apply) : { skipped: true },
      after: args.apply ? {
        totalPrices: await prisma.providerPriceVersion.count(),
        activePrices: await prisma.providerPriceVersion.count({ where: { active: true } }),
        billableActive: await prisma.providerPriceVersion.count({ where: { active: true, billable: true } }),
        gpt4oActive: await prisma.providerPriceVersion.count({ where: { model: 'gpt-4o', active: true } }),
      } : undefined,
    };

    console.log(JSON.stringify(plan, null, 2));
    if (!args.apply) console.error('\nDry run only. Re-run with --apply to write changes.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
