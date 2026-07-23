# Live billing launch (2026-07-23)

Live customer charging was enabled in production for the first time. This directory holds the
scripts and evidence from that launch. Summary of what changed, what was verified, and how to
roll back if needed.

## What changed in prod

1. **Provider price catalog synced** (`sync-prod-provider-prices.js`) -- prod only ever had 5 of
   the 14 real provider/model rows (from the original `20260717111500_billing_foundation`
   migration), all untagged and non-billable. Created the missing 9 (minimax, piper x2, spark x4,
   ltx, whisperx) with the same values already active in local/dev, tagged all 14 with the correct
   `billingTier`, and promoted the 6 customer-metered rows to `billable: true`. The 8
   platform-overhead rows remain `billable: false` -- untouched, and structurally blocked from
   ever being billable (DB check constraint + repository guard).
2. **Stripe webhook endpoint created** -- zero webhook endpoints existed on the Stripe account
   despite `STRIPE_WEBHOOK_SECRET` being set (that secret didn't correspond to anything real).
   Created a real one (`we_1TwCQxA389edpaSlaLsnV6w0`, test mode) for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `refund.created`, `charge.dispute.created`, and updated
   `STRIPE_WEBHOOK_SECRET` in Railway to match its real signing secret.
3. **Charging enabled for exactly one tenant** (`enable-charging-for-tenant.js`) -- Nick's real
   tenant (`a4c6eb31-d33b-44eb-9701-9cc6f44f4110`, n@g.com) only. The other 10 tenants in prod all
   have clearly synthetic/test emails (`ci-test-*`, `ui-test-*`, `csrf-*`, `host-*`, `fix-*`,
   `plan-test-*`, `plan-fix-*`, `short@`, `ok2@`) and were deliberately left `chargingEnabled: false`.
4. **`BILLING_CUSTOMER_CHARGING_ENABLED=true`** set in Railway (global gate).

Both gates are required simultaneously -- see the rollback section below for how each behaves
independently.

## Pre-flight findings (see `prod-snapshot-before-*.txt`)

The original pre-flight snapshot surfaced three real blockers instead of the expected
confirmations: prices were never synced (above), 10/11 tenants looked like test accounts, and
Stripe was not configured in prod at all (`paymentsEnabled: false`, zero webhook endpoints, zero
real purchases ever). All three were resolved before enabling (Stripe was configured with real
secrets by the operator between findings and the fix; the webhook endpoint gap was found and
fixed separately).

## Verification performed (live, against real prod)

- `GET /api/billing/pricing` and `/api/billing/purchase-options`: correct rate ($1/credit), markup
  (1%), and `paymentsEnabled: true`.
- **Real Stripe test-mode purchase**: created a checkout session via the real API, completed it
  with Playwright using Stripe's official test card (`4242 4242 4242 4242`), confirmed the real
  webhook fired and funded credits (`credit_sales.status: credits_funded`, a real
  `purchase_funding` ledger entry, account balance increased by exactly the purchased amount).
- **Real live-charged generation** on Nick's actual account (not a synthetic test tenant) through
  OpenAI text, Gemini text, and MiniMax video (`run-live-charged-launch-smoke-test.js`, using the
  same live wiring the real HTTP server uses): all three reserved live, settled, and the account
  balance decreased by exactly the sum of the three real provider costs
  (`1000000000 -> 999717002` credit micros).
- **Ledger reconciliation**: sum of all ledger deltas for the tenant matches the
  `CreditAccount` balance exactly (`availableMatches: true`, `reservedMatches: true`).
- **Sanity report, scoped to after the enable moment** (`?startAt=2026-07-23T02:30:00Z`): zero
  failed settlements, zero reservations held, zero unpriced usage of any kind. (The report's
  all-time view still shows 6 historical failed settlements and 4 unpriced platform-overhead
  items -- all predate this launch, from before earlier fixes this session; none are
  customer-metered and none are new.)
- Admin console access confirmed working end-to-end (temporarily promoted a throwaway account,
  hit `/api/admin/overview` and `/api/admin/billing/sanity-report`, reverted immediately after).

## Rollback (in order of how fast each one takes effect)

1. **Fastest, no deploy needed**: `railway variables --service web --set "BILLING_CUSTOMER_CHARGING_ENABLED=false"`
   -- stops all new live charges immediately (global gate), while usage/cost tracking continues
   uninterrupted for every provider. This is the "stop the bleeding" lever.
2. **Per-tenant**: `node scripts/enable-charging-for-tenant.js` only ever turns charging *on*; to
   turn it back off for a specific tenant, call `PrismaBillingRepository.setChargingEnabled({
   tenantId, enabled: false, actorUserId, idempotencyKey })` the same way (or via the admin
   console's "Stop charging" button, now that admin access works) -- same ledger/audit trail as
   enabling.
3. **Per-provider**: `PrismaBillingRepository.configurePrice(priceId, { billable: false })` (or the
   admin console's "Disable billing" button) on any of the 6 customer-metered rows. Usage still
   tracks; only that provider stops being charged to customers. The 8 platform-overhead rows can
   never be flipped to `billable: true` in the first place (structurally blocked), so there is
   nothing to roll back there.

## Scripts in this directory (and `../`)

- `sync-prod-provider-prices.js` -- idempotent; re-running it against prod or local/dev is always
  a safe no-op once the catalog matches.
- `enable-charging-for-tenant.js` -- idempotent per tenant (checks current state before writing).
- `run-live-charged-launch-smoke-test.js` -- **not idempotent, incurs real provider cost every
  run** (OpenAI + Gemini + MiniMax). Only re-run deliberately.
