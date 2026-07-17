-- Billing is append-only at the application boundary. Historical price, markup,
-- conversion, cost, reservation, and ledger rows are retained by restrictive FKs.
CREATE TABLE "provider_price_versions" (
    "id" UUID NOT NULL,
    "version_key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "rate_card" JSONB NOT NULL,
    "reservation_nano_usd" BIGINT NOT NULL,
    "evidence_status" TEXT NOT NULL,
    "reconciled_at" TIMESTAMPTZ(3),
    "reconciliation_notes" TEXT,
    "source_reference" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effective_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_price_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_price_versions_reservation_nonnegative" CHECK ("reservation_nano_usd" >= 0),
    CONSTRAINT "provider_price_versions_evidence_status_check" CHECK ("evidence_status" IN ('documented', 'dashboard_reconciled', 'estimated'))
);

CREATE TABLE "markup_policy_versions" (
    "id" UUID NOT NULL,
    "version_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "markup_basis_points" INTEGER NOT NULL,
    "fixed_nano_usd" BIGINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effective_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "markup_policy_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "markup_policy_versions_markup_nonnegative" CHECK ("markup_basis_points" >= 0 AND "fixed_nano_usd" >= 0)
);

CREATE TABLE "site_credit_rate_versions" (
    "id" UUID NOT NULL,
    "version_key" TEXT NOT NULL,
    "nano_usd_per_site_credit" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effective_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_credit_rate_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "site_credit_rate_versions_rate_positive" CHECK ("nano_usd_per_site_credit" > 0)
);

CREATE TABLE "provider_cost_snapshots" (
    "id" UUID NOT NULL,
    "generation_request_id" UUID NOT NULL,
    "usage_event_id" UUID NOT NULL,
    "provider_price_version_id" UUID NOT NULL,
    "usage_snapshot" JSONB NOT NULL,
    "rate_card_snapshot" JSONB NOT NULL,
    "provider_cost_nano_usd" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "calculation" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_cost_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_cost_snapshots_cost_nonnegative" CHECK ("provider_cost_nano_usd" >= 0)
);

CREATE TABLE "credit_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "available_credit_micros" BIGINT NOT NULL DEFAULT 0,
    "reserved_credit_micros" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "credit_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_accounts_balances_nonnegative" CHECK ("available_credit_micros" >= 0 AND "reserved_credit_micros" >= 0)
);

CREATE TABLE "credit_reservations" (
    "id" UUID NOT NULL,
    "generation_request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "provider_price_version_id" UUID,
    "markup_policy_version_id" UUID,
    "site_credit_rate_version_id" UUID,
    "provider_cost_snapshot_id" UUID,
    "charging_mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "estimated_provider_nano_usd" BIGINT NOT NULL DEFAULT 0,
    "quoted_credit_micros" BIGINT NOT NULL DEFAULT 0,
    "reserved_credit_micros" BIGINT NOT NULL DEFAULT 0,
    "final_provider_nano_usd" BIGINT,
    "final_customer_nano_usd" BIGINT,
    "final_credit_micros" BIGINT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),
    CONSTRAINT "credit_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_reservations_amounts_nonnegative" CHECK ("estimated_provider_nano_usd" >= 0 AND "quoted_credit_micros" >= 0 AND "reserved_credit_micros" >= 0 AND ("final_provider_nano_usd" IS NULL OR "final_provider_nano_usd" >= 0) AND ("final_customer_nano_usd" IS NULL OR "final_customer_nano_usd" >= 0) AND ("final_credit_micros" IS NULL OR "final_credit_micros" >= 0))
);

CREATE TABLE "credit_ledger_entries" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "reservation_id" UUID,
    "generation_request_id" UUID,
    "type" TEXT NOT NULL,
    "available_delta_credit_micros" BIGINT NOT NULL,
    "reserved_delta_credit_micros" BIGINT NOT NULL,
    "available_after_credit_micros" BIGINT NOT NULL,
    "reserved_after_credit_micros" BIGINT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_ledger_entries_after_nonnegative" CHECK ("available_after_credit_micros" >= 0 AND "reserved_after_credit_micros" >= 0)
);

CREATE UNIQUE INDEX "provider_price_versions_version_key_key" ON "provider_price_versions"("version_key");
CREATE INDEX "provider_price_versions_provider_modality_model_active_idx" ON "provider_price_versions"("provider", "modality", "model", "active");
CREATE UNIQUE INDEX "provider_price_versions_one_active" ON "provider_price_versions"("provider", "modality", "model") WHERE "active" = true;
CREATE UNIQUE INDEX "markup_policy_versions_version_key_key" ON "markup_policy_versions"("version_key");
CREATE INDEX "markup_policy_versions_active_effective_at_idx" ON "markup_policy_versions"("active", "effective_at");
CREATE UNIQUE INDEX "markup_policy_versions_one_active" ON "markup_policy_versions"((true)) WHERE "active" = true;
CREATE UNIQUE INDEX "site_credit_rate_versions_version_key_key" ON "site_credit_rate_versions"("version_key");
CREATE INDEX "site_credit_rate_versions_active_effective_at_idx" ON "site_credit_rate_versions"("active", "effective_at");
CREATE UNIQUE INDEX "site_credit_rate_versions_one_active" ON "site_credit_rate_versions"((true)) WHERE "active" = true;
CREATE UNIQUE INDEX "provider_cost_snapshots_generation_request_id_key" ON "provider_cost_snapshots"("generation_request_id");
CREATE UNIQUE INDEX "provider_cost_snapshots_usage_event_id_key" ON "provider_cost_snapshots"("usage_event_id");
CREATE INDEX "provider_cost_snapshots_provider_price_version_id_created_at_idx" ON "provider_cost_snapshots"("provider_price_version_id", "created_at");
CREATE UNIQUE INDEX "credit_accounts_tenant_id_key" ON "credit_accounts"("tenant_id");
CREATE UNIQUE INDEX "credit_reservations_generation_request_id_key" ON "credit_reservations"("generation_request_id");
CREATE UNIQUE INDEX "credit_reservations_provider_cost_snapshot_id_key" ON "credit_reservations"("provider_cost_snapshot_id");
CREATE INDEX "credit_reservations_tenant_id_created_at_idx" ON "credit_reservations"("tenant_id", "created_at");
CREATE INDEX "credit_reservations_status_created_at_idx" ON "credit_reservations"("status", "created_at");
CREATE UNIQUE INDEX "credit_ledger_entries_idempotency_key_key" ON "credit_ledger_entries"("idempotency_key");
CREATE INDEX "credit_ledger_entries_tenant_id_created_at_idx" ON "credit_ledger_entries"("tenant_id", "created_at");
CREATE INDEX "credit_ledger_entries_reservation_id_idx" ON "credit_ledger_entries"("reservation_id");

ALTER TABLE "provider_cost_snapshots" ADD CONSTRAINT "provider_cost_snapshots_generation_request_id_fkey" FOREIGN KEY ("generation_request_id") REFERENCES "generation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_cost_snapshots" ADD CONSTRAINT "provider_cost_snapshots_usage_event_id_fkey" FOREIGN KEY ("usage_event_id") REFERENCES "usage_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_cost_snapshots" ADD CONSTRAINT "provider_cost_snapshots_provider_price_version_id_fkey" FOREIGN KEY ("provider_price_version_id") REFERENCES "provider_price_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_generation_request_id_fkey" FOREIGN KEY ("generation_request_id") REFERENCES "generation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_provider_price_version_id_fkey" FOREIGN KEY ("provider_price_version_id") REFERENCES "provider_price_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_markup_policy_version_id_fkey" FOREIGN KEY ("markup_policy_version_id") REFERENCES "markup_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_site_credit_rate_version_id_fkey" FOREIGN KEY ("site_credit_rate_version_id") REFERENCES "site_credit_rate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_provider_cost_snapshot_id_fkey" FOREIGN KEY ("provider_cost_snapshot_id") REFERENCES "provider_cost_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "credit_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Frozen July 17 validation inputs. All providers remain non-billable until
-- their evidence gate is explicitly approved. These rows are never updated to
-- change rates; a new version must be inserted for any pricing change.
INSERT INTO "provider_price_versions" ("id", "version_key", "provider", "modality", "model", "rate_card", "reservation_nano_usd", "evidence_status", "reconciled_at", "reconciliation_notes", "source_reference", "billable", "active") VALUES
('11111111-1111-4111-8111-111111111111', 'openai-gpt-4.1-mini-2026-07-17', 'openai', 'text', 'gpt-4.1-mini', '{"type":"token_components","components":[{"usageKey":"inputTokens","subtractUsageKey":"cachedInputTokens","nanoUsdPerMillion":400000000},{"usageKey":"cachedInputTokens","nanoUsdPerMillion":100000000},{"usageKey":"outputTokens","nanoUsdPerMillion":1600000000}]}'::jsonb, 50000000, 'documented', NULL, 'OpenAI Admin Cost API access unavailable; legacy validation timestamps excluded from automated windows.', 'https://developers.openai.com/api/docs/pricing', false, true),
('22222222-2222-4222-8222-222222222222', 'gemini-3.5-flash-2026-07-17', 'gemini', 'text', 'gemini-3.5-flash', '{"type":"token_components","components":[{"usageKey":"inputTokens","nanoUsdPerMillion":1500000000},{"usageKey":"outputTokens","nanoUsdPerMillion":9000000000}]}'::jsonb, 100000000, 'documented', NULL, 'Google Cloud billing access unavailable; legacy validation timestamps excluded from automated windows.', 'https://ai.google.dev/gemini-api/docs/pricing', false, true),
('33333333-3333-4333-8333-333333333333', 'openai-gpt-image-1-2026-07-17', 'openai', 'image', 'gpt-image-1', '{"type":"token_components","components":[{"usageKey":"inputTextTokens","nanoUsdPerMillion":5000000000},{"usageKey":"inputImageTokens","nanoUsdPerMillion":10000000000},{"usageKey":"outputImageTokens","nanoUsdPerMillion":40000000000}]}'::jsonb, 50000000, 'documented', NULL, 'OpenAI Admin Cost API access unavailable; legacy validation timestamps excluded from automated windows.', 'https://developers.openai.com/api/docs/guides/image-generation#calculating-costs', false, true),
('44444444-4444-4444-8444-444444444444', 'gemini-3.1-flash-image-2026-07-17', 'gemini', 'image', 'gemini-3.1-flash-image', '{"type":"token_components","components":[{"usageKey":"inputTokens","nanoUsdPerMillion":500000000},{"usageKey":"outputTextOrThinkingTokens","nanoUsdPerMillion":3000000000},{"usageKey":"outputImageTokens","nanoUsdPerMillion":60000000000}]}'::jsonb, 100000000, 'documented', NULL, 'Google Cloud billing access unavailable; legacy validation timestamps excluded from automated windows.', 'https://ai.google.dev/gemini-api/docs/pricing', false, true),
('55555555-5555-4555-8555-555555555555', 'dezgo-text2image-2026-07-17', 'dezgo', 'image', 'text2image', '{"type":"linear_steps","usageKey":"steps","quantityKey":"images","baseNanoUsd":18100000,"baseUnits":30}'::jsonb, 20000000, 'estimated', '2026-07-17T10:51:36Z', 'Matching account transaction charged $0.0151; no provider request ID was available and the formula remains estimated.', 'https://dev.dezgo.com/pricing/sd1/', false, true);

-- Safe development defaults. Customer charging is independently disabled and
-- production should activate new, explicitly approved versions.
INSERT INTO "markup_policy_versions" ("id", "version_key", "name", "markup_basis_points", "fixed_nano_usd", "active") VALUES
('66666666-6666-4666-8666-666666666666', 'development-zero-markup-v1', 'Development zero-markup placeholder', 0, 0, true);
INSERT INTO "site_credit_rate_versions" ("id", "version_key", "nano_usd_per_site_credit", "active") VALUES
('77777777-7777-4777-8777-777777777777', 'one-credit-equals-one-cent-v1', 10000000, true);

CREATE FUNCTION reject_billing_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'billing history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_cost_snapshots_append_only BEFORE UPDATE OR DELETE ON "provider_cost_snapshots"
FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER credit_ledger_entries_append_only BEFORE UPDATE OR DELETE ON "credit_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();

CREATE FUNCTION guard_provider_price_version() RETURNS trigger AS $$
BEGIN
  IF OLD."version_key" <> NEW."version_key" OR OLD."provider" <> NEW."provider" OR OLD."modality" <> NEW."modality"
     OR OLD."model" <> NEW."model" OR OLD."currency" <> NEW."currency" OR OLD."rate_card" <> NEW."rate_card"
     OR OLD."reservation_nano_usd" <> NEW."reservation_nano_usd" OR OLD."source_reference" IS DISTINCT FROM NEW."source_reference" THEN
    RAISE EXCEPTION 'provider price inputs are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER provider_price_versions_immutable_inputs BEFORE UPDATE ON "provider_price_versions"
FOR EACH ROW EXECUTE FUNCTION guard_provider_price_version();

CREATE FUNCTION guard_markup_policy_version() RETURNS trigger AS $$
BEGIN
  IF OLD."version_key" <> NEW."version_key" OR OLD."name" <> NEW."name"
     OR OLD."markup_basis_points" <> NEW."markup_basis_points" OR OLD."fixed_nano_usd" <> NEW."fixed_nano_usd" THEN
    RAISE EXCEPTION 'markup inputs are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER markup_policy_versions_immutable_inputs BEFORE UPDATE ON "markup_policy_versions"
FOR EACH ROW EXECUTE FUNCTION guard_markup_policy_version();

CREATE FUNCTION guard_site_credit_rate_version() RETURNS trigger AS $$
BEGIN
  IF OLD."version_key" <> NEW."version_key" OR OLD."nano_usd_per_site_credit" <> NEW."nano_usd_per_site_credit" THEN
    RAISE EXCEPTION 'site credit conversion inputs are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER site_credit_rate_versions_immutable_inputs BEFORE UPDATE ON "site_credit_rate_versions"
FOR EACH ROW EXECUTE FUNCTION guard_site_credit_rate_version();
