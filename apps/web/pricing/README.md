# Billing foundation

Provider accounting is always enabled when PostgreSQL is available. Real tenant credit movement is independently controlled by `BILLING_CUSTOMER_CHARGING_ENABLED`, which defaults to `false`.

A provider call can charge credits only when all gates pass:

1. normalized usage is `observed` or `estimated`;
2. an active provider/model/modality price version exists;
3. that price has `evidence_status = dashboard_reconciled`, a non-null `reconciled_at`, and `billable = true`;
4. active markup and site-credit conversion versions exist;
5. global customer charging is enabled;
6. the tenant credit account has `charging_enabled = true`;
7. the tenant has enough available credits for the pre-call reservation.

The tenant flag is checked inside the same serializable transaction that reserves credits. Disabling a tenant therefore blocks new credit reservations immediately. Existing reservations do not re-check the flag and can still settle, refund unused authorization, or release after failure.

With charging disabled or a provider non-billable, generation continues and exact provider-cost snapshots are still created. No credit account or ledger movement occurs.

## Units

- Provider and customer currency values use integer `nanoUSD` (`$1 = 1,000,000,000 nanoUSD`).
- Credit balances use integer `creditMicros` (`1 site credit = 1,000,000 creditMicros`).
- The conversion version stores `nano_usd_per_site_credit`.
- Integer half-up rounding is used for provider pricing and markup. Credit conversion rounds upward so a charge never under-collects a fractional credit micro.

## Historical integrity

Provider-cost snapshots and credit-ledger entries are append-only at the database layer. Final reservations reject mutation. Price, markup, and conversion inputs cannot be edited; create a new version and activate it. Cost snapshots also duplicate the original usage and rate card, so pricing-code or active-version changes cannot recalculate history.

The July 17 validation rows affected by the former five-hour Prisma timestamp offset are retained as legacy-bad timestamps and excluded from automated reconciliation windows. They are never silently normalized.

## Admin API

Authenticated administrators can use `/api/admin/billing` to inspect active configuration and accounts. Additional routes provide:

- `GET /api/admin/billing/ledger`
- `GET /api/admin/billing/margins`
- `POST /api/admin/billing/credits/grant`
- `PATCH /api/admin/billing/accounts/:tenantId/charging`
- `POST|PATCH /api/admin/billing/prices`
- `POST /api/admin/billing/markups`
- `POST /api/admin/billing/credit-rates`

The seeded markup is deliberately zero and labeled as a development placeholder. Add and activate an approved markup version before enabling customer charging.
