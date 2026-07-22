require('dotenv').config();

const crypto = require('node:crypto');
const Stripe = require('stripe');
const { loadConfig } = require('../src/config/env');
const { createPrismaClient } = require('../src/storage/prisma-client');
const { PrismaBillingRepository } = require('../src/storage/prisma-billing.repository');
const { PrismaPaymentRepository } = require('../src/storage/prisma-payment.repository');
const { PrismaAdminRepository } = require('../src/storage/prisma-admin.repository');
const { createPaymentService } = require('../src/services/payment.service');
const { createSpendSummaryService } = require('../src/services/spend-summary.service');
const { json, serializable } = require('../src/storage/prisma-shared');

function credits(micros) { return (Number(micros || 0) / 1e6).toFixed(6); }

function parseArgs(argv) {
  const args = { apply: false, email: 'n@n.com', welcome: false, purchases: true, grantPendingSales: false, usageDebit: true, charging: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--welcome') args.welcome = true;
    else if (arg === '--grant-pending-sales') args.grantPendingSales = true;
    else if (arg === '--no-purchases') args.purchases = false;
    else if (arg === '--no-usage-debit') args.usageDebit = false;
    else if (arg === '--no-charging') args.charging = false;
    else if (arg === '--email') args.email = argv[++i];
    else throw new Error(`Unknown arg: ${arg}\nUsage: node scripts/backfill-user-credits.js [--apply] [--email n@n.com] [--welcome] [--grant-pending-sales] [--no-purchases] [--no-usage-debit] [--no-charging]`);
  }
  return args;
}

async function findUser(prisma, email) {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    include: { memberships: { include: { workspace: { include: { creditAccount: true } } }, orderBy: { createdAt: 'asc' }, take: 1 } },
  });
  const membership = user?.memberships?.[0];
  if (!user || !membership) throw new Error(`No user found for email ${email}`);
  return { user, tenant: membership.workspace, account: membership.workspace.creditAccount };
}

async function grantWelcome({ prisma, billingRepository, tenantId, userId, actorUserId, apply }) {
  const existing = await prisma.creditLedgerEntry.findFirst({ where: { tenantId, type: 'welcome_grant' } });
  if (existing) return { skipped: true, reason: 'welcome_grant already exists', creditMicros: 0n };
  const policy = await prisma.welcomeCreditPolicyVersion.findFirst({ where: { active: true, effectiveAt: { lte: new Date() } }, orderBy: { effectiveAt: 'desc' } });
  if (!policy) return { skipped: true, reason: 'no active welcome policy', creditMicros: 0n };
  if (!apply) return { skipped: false, dryRun: true, creditMicros: policy.creditMicros, policyKey: policy.versionKey };
  return serializable(prisma, async (db) => {
    const prior = await db.creditLedgerEntry.findUnique({ where: { idempotencyKey: `backfill:welcome:${userId}` } });
    if (prior) return { skipped: true, reason: 'backfill welcome idempotency hit', creditMicros: 0n };
    let account = await db.creditAccount.upsert({ where: { tenantId }, update: {}, create: { id: crypto.randomUUID(), tenantId } });
    account = await db.creditAccount.update({ where: { id: account.id }, data: { availableCreditMicros: { increment: policy.creditMicros } } });
    await db.creditLedgerEntry.create({ data: {
      id: crypto.randomUUID(), accountId: account.id, tenantId, userId,
      welcomeCreditPolicyVersionId: policy.id, type: 'welcome_grant',
      availableDeltaCreditMicros: policy.creditMicros, reservedDeltaCreditMicros: 0n,
      availableAfterCreditMicros: account.availableCreditMicros, reservedAfterCreditMicros: account.reservedCreditMicros,
      idempotencyKey: `backfill:welcome:${userId}`,
      metadata: { policyVersionKey: policy.versionKey, backfill: true },
    } });
    return { skipped: false, creditMicros: policy.creditMicros, policyKey: policy.versionKey };
  });
}

async function grantPendingSales({ prisma, tenantId, userId, actorUserId, apply }) {
  const sales = await prisma.creditSale.findMany({
    where: { tenantId, customerUserId: userId, status: 'checkout_created', creditLedgerEntryId: null },
    orderBy: { createdAt: 'asc' },
  });
  const results = [];
  for (const sale of sales) {
    if (!apply) {
      results.push({ saleId: sale.id, dryRun: true, creditMicros: sale.creditsGranted, subtotalAmount: sale.subtotalAmount.toString() });
      continue;
    }
    const funded = await serializable(prisma, async (db) => {
      const current = await db.creditSale.findUnique({ where: { id: sale.id } });
      if (!current || current.creditLedgerEntryId) return { reused: true, sale: current };
      let account = await db.creditAccount.upsert({ where: { tenantId }, update: {}, create: { id: crypto.randomUUID(), tenantId } });
      account = await db.creditAccount.update({ where: { id: account.id }, data: { availableCreditMicros: { increment: sale.creditsGranted } } });
      const ledger = await db.creditLedgerEntry.create({ data: {
        id: crypto.randomUUID(), accountId: account.id, tenantId, userId, saleId: sale.id,
        type: 'purchase_funding', availableDeltaCreditMicros: sale.creditsGranted, reservedDeltaCreditMicros: 0n,
        availableAfterCreditMicros: account.availableCreditMicros, reservedAfterCreditMicros: account.reservedCreditMicros,
        idempotencyKey: `backfill:purchase-funding:${sale.id}`,
        metadata: json({ backfill: true, reason: 'operator_granted_pending_checkout', checkoutSessionId: sale.processorCheckoutSessionId }),
      } });
      const updated = await db.creditSale.update({ where: { id: sale.id }, data: {
        status: 'credits_funded', creditLedgerEntryId: ledger.id, paidAt: new Date(),
      } });
      await db.checkoutAttempt.updateMany({ where: { saleId: sale.id }, data: { status: 'completed', completedAt: new Date() } });
      return { reused: false, sale: updated, ledger };
    });
    results.push({ saleId: sale.id, funded: true, reused: funded.reused, creditMicros: sale.creditsGranted });
  }
  return results;
}

async function fundStripeSales({ prisma, payments, stripe, tenantId, userId, apply }) {
  const sales = await prisma.creditSale.findMany({
    where: { tenantId, customerUserId: userId, status: 'checkout_created', creditLedgerEntryId: null },
    orderBy: { createdAt: 'asc' },
  });
  const results = [];
  for (const sale of sales) {
    if (!sale.processorCheckoutSessionId) {
      results.push({ saleId: sale.id, skipped: true, reason: 'missing checkout session id' });
      continue;
    }
    const session = await stripe.checkout.sessions.retrieve(sale.processorCheckoutSessionId);
    if (session.payment_status !== 'paid') {
      results.push({ saleId: sale.id, sessionId: session.id, skipped: true, reason: `payment_status=${session.payment_status}` });
      continue;
    }
    if (!apply) {
      results.push({ saleId: sale.id, sessionId: session.id, dryRun: true, creditMicros: sale.creditsGranted });
      continue;
    }
    const eventId = `backfill_fund:${sale.id}`;
    const funded = await payments.processWebhook({
      id: eventId,
      type: 'checkout.session.completed',
      data: { object: session },
    });
    results.push({ saleId: sale.id, sessionId: session.id, funded: true, duplicate: funded?.duplicate === true, creditMicros: sale.creditsGranted });
  }
  return results;
}

async function debitHistoricalUsage({ prisma, tenantId, actorUserId, spendSummary, apply }) {
  const idempotencyKey = `backfill:usage-debit:${tenantId}`;
  const existing = await prisma.creditLedgerEntry.findUnique({ where: { idempotencyKey } });
  if (existing) return { skipped: true, reason: 'usage debit already applied', creditMicros: 0n };
  const spend = await spendSummary.getTenantSpend(tenantId);
  const creditMicros = BigInt(spend.totalCreditMicros || 0);
  if (creditMicros <= 0n) return { skipped: true, reason: 'no billable usage to debit', creditMicros: 0n };
  if (!apply) return { skipped: false, dryRun: true, creditMicros, totalCredits: spend.totalCredits };
  return serializable(prisma, async (db) => {
    const account = await db.creditAccount.findUnique({ where: { tenantId } });
    if (!account) throw new Error('Credit account missing before usage debit');
    if (account.availableCreditMicros < creditMicros) {
      throw new Error(`Usage debit ${credits(creditMicros)} exceeds available ${credits(account.availableCreditMicros)}`);
    }
    const after = await db.creditAccount.update({
      where: { id: account.id },
      data: { availableCreditMicros: { decrement: creditMicros } },
    });
    await db.creditLedgerEntry.create({ data: {
      id: crypto.randomUUID(), accountId: account.id, tenantId, userId: actorUserId,
      type: 'backfill_debit', availableDeltaCreditMicros: -creditMicros, reservedDeltaCreditMicros: 0n,
      availableAfterCreditMicros: after.availableCreditMicros, reservedAfterCreditMicros: after.reservedCreditMicros,
      idempotencyKey,
      metadata: json({ reason: 'historical_usage_before_live_charging', totalCredits: spend.totalCredits }),
    } });
    return { skipped: false, creditMicros, totalCredits: spend.totalCredits };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const prisma = createPrismaClient(config.env.DATABASE_URL);
  const actorUserId = String(config.env.ADMIN_OWNER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean)[0] || null;
  const billingRepository = new PrismaBillingRepository(prisma);
  const paymentRepository = new PrismaPaymentRepository(prisma);
  const adminRepository = new PrismaAdminRepository(prisma);
  const spendSummary = createSpendSummaryService({ prisma, billingRepository });
  const stripe = config.payments.stripeSecretKey ? new Stripe(config.payments.stripeSecretKey, { maxNetworkRetries: 2 }) : null;
  const payments = createPaymentService({
    repository: paymentRepository,
    stripe,
    webhookSecret: config.payments.stripeWebhookSecret,
    publicAppUrl: config.payments.publicAppUrl,
  });

  try {
    const { user, tenant, account } = await findUser(prisma, args.email);
    const plan = {
      mode: args.apply ? 'apply' : 'dry-run',
      user: { id: user.id, email: user.email, displayName: user.displayName },
      tenant: { id: tenant.id, name: tenant.name },
      current: {
        availableCreditMicros: account?.availableCreditMicros?.toString() || '0',
        chargingEnabled: account?.chargingEnabled ?? false,
      },
      steps: {},
    };

    if (args.welcome) {
      plan.steps.welcome = await grantWelcome({ prisma, billingRepository, tenantId: tenant.id, userId: user.id, actorUserId, apply: args.apply });
    }

    if (args.purchases) {
      if (args.grantPendingSales) {
        plan.steps.purchases = await grantPendingSales({ prisma, tenantId: tenant.id, userId: user.id, actorUserId, apply: args.apply });
      } else if (!stripe || !payments.enabled) plan.steps.purchases = { skipped: true, reason: 'Stripe not configured' };
      else plan.steps.purchases = await fundStripeSales({ prisma, payments, stripe, tenantId: tenant.id, userId: user.id, apply: args.apply });
    }

    if (args.usageDebit) {
      plan.steps.usageDebit = await debitHistoricalUsage({ prisma, tenantId: tenant.id, actorUserId, spendSummary, apply: args.apply });
    }

    if (args.charging) {
      if (!args.apply) plan.steps.charging = { dryRun: true, enabled: true };
      else {
        const result = await billingRepository.setChargingEnabled({
          tenantId: tenant.id, enabled: true, actorUserId,
          idempotencyKey: `backfill:charging:${tenant.id}:true`,
        });
        if (adminRepository && actorUserId && !result.reused && !result.unchanged) {
          await adminRepository.recordAudit({
            actorUserId, tenantId: tenant.id, action: 'tenant.charging_enabled', targetType: 'credit_account', targetId: result.account.id,
            reason: 'Enabled via scripts/backfill-user-credits.js after operator backfill.',
            after: { chargingEnabled: true, ledgerEntryId: result.entry?.id },
          });
        }
        plan.steps.charging = { enabled: result.account.chargingEnabled, unchanged: !!result.unchanged };
      }
    }

    const finalAccount = await prisma.creditAccount.findUnique({ where: { tenantId: tenant.id } });
    plan.final = {
      availableCreditMicros: finalAccount?.availableCreditMicros?.toString() || '0',
      availableCredits: credits(finalAccount?.availableCreditMicros || 0n),
      chargingEnabled: finalAccount?.chargingEnabled ?? false,
    };

    const grantMicros = [
      plan.steps.welcome?.creditMicros,
      ...(Array.isArray(plan.steps.purchases) ? plan.steps.purchases.map((row) => row.creditMicros) : []),
    ].reduce((sum, value) => sum + BigInt(value || 0), 0n);
    const debitMicros = BigInt(plan.steps.usageDebit?.creditMicros || 0);
    if (grantMicros > 0n || debitMicros > 0n) {
      plan.projectedCredits = credits(grantMicros - debitMicros);
      if (grantMicros < debitMicros) {
        plan.warning = 'Projected grants are less than the usage debit; apply will fail unless you add --welcome, --grant-pending-sales, or --no-usage-debit.';
      }
    }

    console.log(JSON.stringify(plan, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
    if (!args.apply) console.error('\nDry run only. Re-run with --apply to write changes.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
