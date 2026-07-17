ALTER TABLE "provider_price_versions"
ADD CONSTRAINT "provider_price_versions_billable_requires_reconciliation"
CHECK ("billable" = false OR ("evidence_status" = 'dashboard_reconciled' AND "reconciled_at" IS NOT NULL));
