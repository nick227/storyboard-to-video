DROP TRIGGER IF EXISTS credit_sales_append_only ON "credit_sales";
ALTER TABLE "credit_sales" DROP CONSTRAINT IF EXISTS "credit_sales_status_check";
ALTER TABLE "credit_sales" ALTER COLUMN "credit_ledger_entry_id" DROP NOT NULL;
ALTER TABLE "credit_sales" ALTER COLUMN "recorded_by_admin_id" DROP NOT NULL;
ALTER TABLE "credit_sales" ADD COLUMN "credit_pack_id" UUID;
ALTER TABLE "credit_sales" ADD COLUMN "credits_granted_micros" BIGINT;
ALTER TABLE "credit_sales" ADD COLUMN "processor" TEXT;
ALTER TABLE "credit_sales" ADD COLUMN "processor_customer_id" TEXT;
ALTER TABLE "credit_sales" ADD COLUMN "processor_checkout_session_id" TEXT;
ALTER TABLE "credit_sales" ADD COLUMN "processor_payment_intent_id" TEXT;
ALTER TABLE "credit_sales" ADD COLUMN "subtotal_amount" BIGINT;
ALTER TABLE "credit_sales" ADD COLUMN "tax_amount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "credit_sales" ADD COLUMN "total_amount" BIGINT;
ALTER TABLE "credit_sales" ADD COLUMN "refunded_amount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "credit_sales" ADD COLUMN "credits_reversed_micros" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "credit_sales" ADD COLUMN "refund_resolution_required" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "credit_sales" ADD COLUMN "paid_at" TIMESTAMPTZ(3);
ALTER TABLE "credit_sales" ADD COLUMN "refunded_at" TIMESTAMPTZ(3);
ALTER TABLE "credit_sales" ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "credit_sales" SET
  "credits_granted_micros" = "credits_purchased_micros",
  "processor" = "payment_provider",
  "subtotal_amount" = GREATEST(1, "cash_amount_nano_usd" / 10000000),
  "total_amount" = GREATEST(1, "cash_amount_nano_usd" / 10000000),
  "paid_at" = "occurred_at";

ALTER TABLE "credit_sales" ALTER COLUMN "credits_granted_micros" SET NOT NULL;
ALTER TABLE "credit_sales" ALTER COLUMN "processor" SET NOT NULL;
ALTER TABLE "credit_sales" ALTER COLUMN "subtotal_amount" SET NOT NULL;
ALTER TABLE "credit_sales" ALTER COLUMN "total_amount" SET NOT NULL;
ALTER TABLE "credit_sales" ALTER COLUMN "status" SET DEFAULT 'pending';
UPDATE "credit_sales" SET "status" = 'credits_funded' WHERE "status" = 'completed';

ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_status_check" CHECK ("status" IN (
  'pending', 'checkout_created', 'paid', 'credits_funded', 'expired',
  'partially_refunded', 'refunded', 'disputed'
));
ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_payment_amounts_check" CHECK (
  "cash_amount_nano_usd" > 0 AND "credits_purchased_micros" > 0 AND
  "credits_granted_micros" > 0 AND "subtotal_amount" > 0 AND
  "tax_amount" >= 0 AND "total_amount" >= "subtotal_amount" AND
  "refunded_amount" >= 0 AND "refunded_amount" <= "total_amount" AND
  "credits_reversed_micros" >= 0 AND "credits_reversed_micros" <= "credits_granted_micros"
);

CREATE TABLE "credit_packs" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "unit_amount" BIGINT NOT NULL,
  "credits_granted_micros" BIGINT NOT NULL,
  "stripe_price_id" TEXT,
  "tax_behavior" TEXT NOT NULL DEFAULT 'exclusive',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "active_from" TIMESTAMPTZ(3),
  "active_until" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_packs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_packs_terms_check" CHECK (
    "version" > 0 AND "unit_amount" > 0 AND "credits_granted_micros" > 0 AND
    "currency" = upper("currency") AND
    "tax_behavior" IN ('exclusive', 'inclusive', 'unspecified') AND
    "status" IN ('draft', 'active', 'retired') AND
    ("status" <> 'active' OR ("stripe_price_id" IS NOT NULL AND "active_from" IS NOT NULL)) AND
    ("active_until" IS NULL OR "active_from" IS NULL OR "active_until" > "active_from")
  )
);

CREATE TABLE "payment_customers" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "processor" TEXT NOT NULL DEFAULT 'stripe',
  "processor_customer_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkout_attempts" (
  "id" UUID NOT NULL,
  "sale_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "processor" TEXT NOT NULL DEFAULT 'stripe',
  "idempotency_key" TEXT NOT NULL,
  "processor_checkout_session_id" TEXT,
  "checkout_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "checkout_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "checkout_attempts_status_check" CHECK ("status" IN ('pending', 'checkout_created', 'completed', 'expired', 'failed'))
);

CREATE TABLE "payment_events" (
  "id" UUID NOT NULL,
  "processor" TEXT NOT NULL DEFAULT 'stripe',
  "processor_event_id" TEXT NOT NULL,
  "processor_object_id" TEXT,
  "type" TEXT NOT NULL,
  "sale_id" UUID,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'received',
  "error" TEXT,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(3),
  CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_events_status_check" CHECK ("status" IN ('received', 'processed', 'ignored', 'failed'))
);

CREATE UNIQUE INDEX "credit_packs_code_version_key" ON "credit_packs"("code", "version");
CREATE UNIQUE INDEX "credit_packs_stripe_price_id_key" ON "credit_packs"("stripe_price_id");
CREATE INDEX "credit_packs_status_active_from_active_until_idx" ON "credit_packs"("status", "active_from", "active_until");
CREATE UNIQUE INDEX "payment_customers_processor_customer_id_key" ON "payment_customers"("processor_customer_id");
CREATE UNIQUE INDEX "payment_customers_tenant_id_user_id_processor_key" ON "payment_customers"("tenant_id", "user_id", "processor");
CREATE INDEX "payment_customers_user_id_idx" ON "payment_customers"("user_id");
CREATE UNIQUE INDEX "checkout_attempts_idempotency_key_key" ON "checkout_attempts"("idempotency_key");
CREATE UNIQUE INDEX "checkout_attempts_processor_checkout_session_id_key" ON "checkout_attempts"("processor_checkout_session_id");
CREATE INDEX "checkout_attempts_sale_id_created_at_idx" ON "checkout_attempts"("sale_id", "created_at");
CREATE INDEX "checkout_attempts_tenant_id_created_at_idx" ON "checkout_attempts"("tenant_id", "created_at");
CREATE UNIQUE INDEX "payment_events_processor_event_id_key" ON "payment_events"("processor_event_id");
CREATE UNIQUE INDEX "payment_events_processor_type_processor_object_id_key" ON "payment_events"("processor", "type", "processor_object_id");
CREATE INDEX "payment_events_sale_id_received_at_idx" ON "payment_events"("sale_id", "received_at");
CREATE INDEX "payment_events_status_received_at_idx" ON "payment_events"("status", "received_at");
CREATE UNIQUE INDEX "credit_sales_processor_checkout_session_id_key" ON "credit_sales"("processor_checkout_session_id");
CREATE UNIQUE INDEX "credit_sales_processor_payment_intent_id_key" ON "credit_sales"("processor_payment_intent_id");

ALTER TABLE "credit_ledger_entries" ADD COLUMN "sale_id" UUID;
UPDATE "credit_ledger_entries" l SET "sale_id" = s."id" FROM "credit_sales" s WHERE s."credit_ledger_entry_id" = l."id";
CREATE INDEX "credit_ledger_entries_sale_id_idx" ON "credit_ledger_entries"("sale_id");

ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_credit_pack_id_fkey" FOREIGN KEY ("credit_pack_id") REFERENCES "credit_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "credit_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_customers" ADD CONSTRAINT "payment_customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_customers" ADD CONSTRAINT "payment_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "credit_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "credit_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION protect_credit_pack_terms() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credit pack versions are immutable'; END IF;
  IF NEW.code <> OLD.code OR NEW.version <> OLD.version OR NEW.name <> OLD.name OR
     NEW.currency <> OLD.currency OR NEW.unit_amount <> OLD.unit_amount OR
     NEW.credits_granted_micros <> OLD.credits_granted_micros OR NEW.tax_behavior <> OLD.tax_behavior THEN
    RAISE EXCEPTION 'credit pack terms are immutable';
  END IF;
  IF OLD.status <> 'draft' AND NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id THEN
    RAISE EXCEPTION 'published Stripe price IDs are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER credit_pack_terms_immutable BEFORE UPDATE OR DELETE ON "credit_packs"
FOR EACH ROW EXECUTE FUNCTION protect_credit_pack_terms();

CREATE OR REPLACE FUNCTION protect_credit_sale_terms() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credit sales cannot be deleted'; END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.customer_user_id <> OLD.customer_user_id OR
     NEW.credit_pack_id IS DISTINCT FROM OLD.credit_pack_id OR NEW.cash_amount_nano_usd <> OLD.cash_amount_nano_usd OR
     NEW.credits_purchased_micros <> OLD.credits_purchased_micros OR NEW.credits_granted_micros <> OLD.credits_granted_micros OR
     NEW.currency <> OLD.currency OR NEW.payment_provider <> OLD.payment_provider OR NEW.processor <> OLD.processor OR
     NEW.subtotal_amount <> OLD.subtotal_amount OR NEW.occurred_at <> OLD.occurred_at OR
     NEW.external_payment_id IS DISTINCT FROM OLD.external_payment_id OR NEW.recorded_by_admin_id IS DISTINCT FROM OLD.recorded_by_admin_id OR
     NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'credit sale terms are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER credit_sale_terms_immutable BEFORE UPDATE OR DELETE ON "credit_sales"
FOR EACH ROW EXECUTE FUNCTION protect_credit_sale_terms();

INSERT INTO "credit_packs" ("id", "code", "version", "name", "unit_amount", "credits_granted_micros", "tax_behavior", "status") VALUES
  ('10000000-0000-4000-8000-000000000001', 'starter', 1, 'Starter', 1000, 1000000000, 'exclusive', 'draft'),
  ('10000000-0000-4000-8000-000000000002', 'creator', 1, 'Creator', 2500, 2750000000, 'exclusive', 'draft'),
  ('10000000-0000-4000-8000-000000000003', 'studio', 1, 'Studio', 5000, 6000000000, 'exclusive', 'draft');
