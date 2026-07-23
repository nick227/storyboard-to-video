require('dotenv').config();

const Stripe = require('stripe');
const { loadConfig } = require('../../src/config/env');
const { createPrismaClient } = require('../../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../../src/storage/prisma-billing.repository');
const { createPaymentService } = require('../../src/services/payment.service');

// One-command billing operations sanity check. Read-only -- never mutates anything.
//
// Locally: just `node scripts/billing-launch/prod-sanity-check.js` (reads apps/web/.env).
//
// Against prod: needs the FULL real runtime environment, not just DATABASE_URL -- the Stripe
// webhook check reads PUBLIC_APP_URL to know which URL to look for, and a partial override (e.g.
// `DATABASE_URL='<prod>' node ...`) silently leaves PUBLIC_APP_URL pointed at localhost, which
// makes the webhook check fail even though prod is actually fine. Get a real snapshot and use it
// (`railway run` alone can't reach postgres.railway.internal from outside Railway's network, so
// DATABASE_URL specifically needs the public proxy URL swapped in after the snapshot):
//   railway run --service web -- env > /tmp/prod_env.txt
//   sed -i 's#^DATABASE_URL=.*#DATABASE_URL=<public proxy URL from the Postgres service>#' /tmp/prod_env.txt
//   node -e "require('fs').readFileSync('/tmp/prod_env.txt','utf8').split('\n').forEach(l=>{const i=l.indexOf('=');if(i>0)process.env[l.slice(0,i)]=l.slice(i+1)});require('./scripts/billing-launch/prod-sanity-check.js')"
//
// Checks, in order: billing config singletons, provider price catalog, tenant charging flags,
// Stripe config/webhook health, and ledger reconciliation for every tenant. Exits non-zero if any
// check fails, so it's safe to use as a CI/cron gate, not just an interactive report.

const TEST_EMAIL_PATTERN = /(^|[._-])(test|csrf|check|qa)([._-]|\d|$)/i;

function heading(text) { console.log(`\n=== ${text} ===`); }
function ok(label, detail = '') { console.log(`  ✓ ${label}${detail ? ` -- ${detail}` : ''}`); }
function warn(label, detail = '') { console.log(`  ! ${label}${detail ? ` -- ${detail}` : ''}`); }
function fail(label, detail = '') { console.log(`  ✗ ${label}${detail ? ` -- ${detail}` : ''}`); }

async function main() {
  const config = loadConfig();
  if (!config.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  let failures = 0;
  const flagFail = (...args) => { failures += 1; fail(...args); };

  try {
    const billing = new PrismaBillingRepository(prisma);

    heading('Billing config');
    const [rate, markup, welcome] = await Promise.all([billing.activeCreditRate(), billing.activeMarkup(), prisma.welcomeCreditPolicyVersion.findFirst({ where: { active: true } })]);
    if (rate) ok('Credit rate', `${rate.versionKey}: $${Number(rate.nanoUsdPerSiteCredit) / 1e9}/credit`); else flagFail('Credit rate', 'no active SiteCreditRateVersion');
    if (markup) ok('Markup', `${markup.versionKey}: ${Number(markup.markupBasisPoints) / 100}%`); else flagFail('Markup', 'no active MarkupPolicyVersion');
    if (welcome) ok('Welcome grant', `${welcome.versionKey}: ${Number(welcome.creditMicros) / 1e6} credits`); else flagFail('Welcome grant', 'no active WelcomeCreditPolicyVersion');

    heading('Provider price catalog');
    const prices = await prisma.providerPriceVersion.findMany({ where: { active: true }, select: { versionKey: true, provider: true, modality: true, model: true, billingTier: true, billable: true } });
    const untagged = prices.filter((p) => !p.billingTier);
    const customerMetered = prices.filter((p) => p.billingTier === 'customer_metered');
    const platformOverhead = prices.filter((p) => p.billingTier === 'platform_overhead');
    const platformOverheadBillable = platformOverhead.filter((p) => p.billable);
    const customerMeteredNotBillable = customerMetered.filter((p) => !p.billable);
    ok('Active price rows', `${prices.length} total`);
    ok('customer_metered', `${customerMetered.length} rows, ${customerMetered.filter((p) => p.billable).length} billable`);
    ok('platform_overhead', `${platformOverhead.length} rows, ${platformOverhead.filter((p) => p.billable).length} billable (should be 0)`);
    if (untagged.length) warn('Untagged rows (billingTier: null)', untagged.map((p) => p.versionKey).join(', '));
    if (platformOverheadBillable.length) flagFail('platform_overhead rows marked billable', platformOverheadBillable.map((p) => p.versionKey).join(', '));
    else ok('No platform_overhead row is billable');
    if (customerMeteredNotBillable.length) warn('customer_metered rows not yet billable', customerMeteredNotBillable.map((p) => p.versionKey).join(', '));

    heading('Tenant charging flags');
    const accounts = await prisma.creditAccount.findMany({ select: { tenantId: true, chargingEnabled: true } });
    const enabledAccounts = accounts.filter((a) => a.chargingEnabled);
    ok('Total tenants', `${accounts.length}`);
    ok('Charging-enabled tenants', `${enabledAccounts.length}`);
    if (enabledAccounts.length) {
      const owners = await prisma.membership.findMany({ where: { tenantId: { in: enabledAccounts.map((a) => a.tenantId) }, role: 'owner' }, include: { user: { select: { email: true } } } });
      for (const owner of owners) {
        const looksLikeTest = TEST_EMAIL_PATTERN.test(owner.user.email);
        if (looksLikeTest) warn(`Charging enabled for ${owner.user.email}`, 'email pattern looks like a test/throwaway account -- verify this is intentional');
        else ok(`Charging enabled for ${owner.user.email}`);
      }
    }

    heading('Stripe config');
    const stripe = config.payments.stripeSecretKey ? new Stripe(config.payments.stripeSecretKey, { maxNetworkRetries: 2 }) : null;
    const payments = createPaymentService({ repository: null, stripe, webhookSecret: config.payments.stripeWebhookSecret, publicAppUrl: config.payments.publicAppUrl });
    if (!payments.enabled) flagFail('Stripe', 'STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not both configured -- purchases are disabled');
    else {
      ok('Stripe secret + webhook secret configured');
      const health = await payments.checkWebhookHealth().catch((error) => ({ error: error.message }));
      if (health.error) flagFail('Stripe webhook check failed', health.error);
      else if (!health.endpointFound) flagFail('Stripe webhook endpoint', `no enabled endpoint found for ${health.webhookUrl}`);
      else if (health.missingEvents.length) warn('Stripe webhook endpoint', `${health.endpointId} is missing events: ${health.missingEvents.join(', ')}`);
      else ok('Stripe webhook endpoint', `${health.endpointId} enabled, all required events subscribed`);
    }

    heading('Ledger reconciliation (every tenant)');
    const ledgerByTenant = await prisma.creditLedgerEntry.groupBy({ by: ['tenantId'], _sum: { availableDeltaCreditMicros: true, reservedDeltaCreditMicros: true } });
    const ledgerMap = new Map(ledgerByTenant.map((row) => [row.tenantId, row._sum]));
    const allAccounts = await prisma.creditAccount.findMany({ select: { tenantId: true, availableCreditMicros: true, reservedCreditMicros: true } });
    let mismatches = 0;
    for (const account of allAccounts) {
      const sums = ledgerMap.get(account.tenantId) || { availableDeltaCreditMicros: 0n, reservedDeltaCreditMicros: 0n };
      const availableMatches = (sums.availableDeltaCreditMicros || 0n) === account.availableCreditMicros;
      const reservedMatches = (sums.reservedDeltaCreditMicros || 0n) === account.reservedCreditMicros;
      if (!availableMatches || !reservedMatches) { mismatches += 1; flagFail(`Tenant ${account.tenantId}`, `ledger sum does not match account balance (available: ledger=${sums.availableDeltaCreditMicros} vs account=${account.availableCreditMicros})`); }
    }
    if (!mismatches) ok(`All ${allAccounts.length} tenants reconcile exactly`);

    heading('Rollback commands');
    console.log(`  # 1. Stop all new live charges immediately (usage tracking continues):`);
    console.log(`  railway variables --service web --set "BILLING_CUSTOMER_CHARGING_ENABLED=false"`);
    console.log(`  # 2. Disable charging for one tenant (via PrismaBillingRepository.setChargingEnabled, same as the admin console's "Stop charging" button):`);
    console.log(`  DATABASE_URL='<target>' node -e "require('dotenv').config();const{loadConfig}=require('./src/config/env');const{createPrismaClient}=require('./src/storage/prisma-client');const{PrismaBillingRepository}=require('./src/storage/prisma-billing.repository');(async()=>{const p=createPrismaClient(loadConfig().env.DATABASE_URL);const b=new PrismaBillingRepository(p);await b.setChargingEnabled({tenantId:'<tenantId>',enabled:false,actorUserId:'<adminUserId>',idempotencyKey:'rollback:'+Date.now()});await p.\\$disconnect();})();"`);
    console.log(`  # 3. Disable billing for one provider price (via PrismaBillingRepository.configurePrice, same as the admin console's "Disable billing" button):`);
    console.log(`  DATABASE_URL='<target>' node -e "require('dotenv').config();const{loadConfig}=require('./src/config/env');const{createPrismaClient}=require('./src/storage/prisma-client');const{PrismaBillingRepository}=require('./src/storage/prisma-billing.repository');(async()=>{const p=createPrismaClient(loadConfig().env.DATABASE_URL);const b=new PrismaBillingRepository(p);await b.configurePrice('<priceVersionId>',{billable:false});await p.\\$disconnect();})();"`);

    console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All checks passed'}`);
    if (failures) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
