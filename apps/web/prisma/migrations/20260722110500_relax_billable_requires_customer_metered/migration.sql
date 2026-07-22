-- Prototype provider-cost billing policy: only a customer_metered price may ever be billable,
-- and it only needs a recorded reconciledAt (evidence-acceptance date) -- evidenceStatus may be
-- 'documented' | 'estimated' | 'dashboard_reconciled'. A platform_overhead (or null-tier) price
-- is hard-blocked from billable:true regardless of evidence, at the database level.
ALTER TABLE "provider_price_versions" DROP CONSTRAINT "provider_price_versions_billable_requires_reconciliation";

ALTER TABLE "provider_price_versions"
ADD CONSTRAINT "provider_price_versions_billable_requires_reconciliation"
CHECK ("billable" = false OR ("billing_tier" = 'customer_metered' AND "reconciled_at" IS NOT NULL));
