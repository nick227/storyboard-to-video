# Live billing operations runbook

Short, action-first. For the full launch narrative and evidence, see `README.md` and
`prod-launch-verification-20260723.txt` in this directory.

## Run the sanity check first

Before doing anything below, run `prod-sanity-check.js` (see its header comment for the exact
prod invocation) -- it checks billing config, the price catalog, tenant charging flags, Stripe,
and ledger reconciliation in one pass, and prints these same rollback commands at the end.

## Disable global charging (fastest, no deploy)

Stops **all** new live charges immediately, everywhere, for every tenant. Usage/cost tracking
keeps running uninterrupted -- this only stops customers from being charged, not from generating.

```bash
railway variables --service web --set "BILLING_CUSTOMER_CHARGING_ENABLED=false"
```

Reverse: same command with `=true`. Takes effect on the next deploy Railway triggers automatically
for the variable change (usually seconds).

## Disable charging for one tenant

Use when the problem is scoped to a single customer, not everyone. Goes through the app's own
`setChargingEnabled` method -- the same one the admin console's "Stop charging" button calls -- so
it's ledger-logged and audit-logged like any real admin action, never a raw update.

```bash
DATABASE_URL='<target>' node -e "
require('dotenv').config();
const { loadConfig } = require('./src/config/env');
const { createPrismaClient } = require('./src/storage/prisma-client');
const { PrismaBillingRepository } = require('./src/storage/prisma-billing.repository');
(async () => {
  const prisma = createPrismaClient(loadConfig().env.DATABASE_URL);
  const billing = new PrismaBillingRepository(prisma);
  await billing.setChargingEnabled({
    tenantId: '<tenantId>', enabled: false,
    actorUserId: '<real admin user id>', idempotencyKey: 'rollback:' + Date.now(),
  });
  await prisma.\$disconnect();
})();
"
```

Or use the admin console directly: Users tab -> find the tenant -> "Stop charging".

## Disable billing for one provider

Use when a specific provider's pricing looks wrong (bad rate, unexpected cost spike) but
everything else should keep charging normally. Usage still tracks; only that provider stops being
charged to customers.

```bash
DATABASE_URL='<target>' node -e "
require('dotenv').config();
const { loadConfig } = require('./src/config/env');
const { createPrismaClient } = require('./src/storage/prisma-client');
const { PrismaBillingRepository } = require('./src/storage/prisma-billing.repository');
(async () => {
  const prisma = createPrismaClient(loadConfig().env.DATABASE_URL);
  const billing = new PrismaBillingRepository(prisma);
  await billing.configurePrice('<providerPriceVersionId>', { billable: false });
  await prisma.\$disconnect();
})();
"
```

Or use the admin console directly: Pricing & sales tab -> find the price row -> "Disable billing".

A `platform_overhead`-tagged price can never be flipped to `billable: true` in the first place
(blocked by both the repository guard and a DB check constraint) -- there is nothing to roll back
for those.

## Verify ledger balance for a tenant

Sum of every `CreditLedgerEntry.availableDeltaCreditMicros` for a tenant must always equal that
tenant's current `CreditAccount.availableCreditMicros` exactly (same for `reservedDelta` /
`reservedCreditMicros`) -- the ledger is append-only and every balance-affecting action writes one.

```bash
DATABASE_URL='<target>' psql "$DATABASE_URL" -c "
SELECT ca.tenant_id,
  ca.available_credit_micros AS account_available,
  COALESCE(SUM(cle.available_delta_credit_micros), 0) AS ledger_sum_available,
  ca.available_credit_micros - COALESCE(SUM(cle.available_delta_credit_micros), 0) AS diff
FROM credit_accounts ca
LEFT JOIN credit_ledger_entries cle ON cle.tenant_id = ca.tenant_id
WHERE ca.tenant_id = '<tenantId>'
GROUP BY ca.tenant_id, ca.available_credit_micros;
"
```

`diff` must be `0`. `prod-sanity-check.js` runs this same check for every tenant automatically --
prefer that for a routine check; use the query above to zoom in on one tenant during an incident.

Admin console equivalent: Overview tab -> "Live billing status" panel -> Failed settlements /
Stuck reservations cards, or `GET /api/admin/billing/sanity-report` directly.
