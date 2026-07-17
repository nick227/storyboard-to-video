ALTER TABLE "users" ADD COLUMN "platform_role" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "users" ADD CONSTRAINT "users_platform_role_check" CHECK ("platform_role" IN ('user', 'admin', 'super_admin'));
CREATE INDEX "users_platform_role_status_idx" ON "users"("platform_role", "status");

CREATE TABLE "credit_sales" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "customer_user_id" UUID NOT NULL,
  "cash_amount_nano_usd" BIGINT NOT NULL,
  "credits_purchased_micros" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "payment_provider" TEXT NOT NULL,
  "external_payment_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "credit_ledger_entry_id" UUID NOT NULL,
  "recorded_by_admin_id" UUID NOT NULL,
  "notes" TEXT,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_sales_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_sales_amounts_positive" CHECK ("cash_amount_nano_usd" > 0 AND "credits_purchased_micros" > 0),
  CONSTRAINT "credit_sales_status_check" CHECK ("status" IN ('completed', 'reversed'))
);

CREATE TABLE "admin_audit_events" (
  "id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "tenant_id" UUID,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "reason" TEXT,
  "before" JSONB,
  "after" JSONB,
  "request_id" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_sales_external_payment_id_key" ON "credit_sales"("external_payment_id");
CREATE UNIQUE INDEX "credit_sales_credit_ledger_entry_id_key" ON "credit_sales"("credit_ledger_entry_id");
CREATE INDEX "credit_sales_tenant_id_occurred_at_idx" ON "credit_sales"("tenant_id", "occurred_at");
CREATE INDEX "credit_sales_customer_user_id_occurred_at_idx" ON "credit_sales"("customer_user_id", "occurred_at");
CREATE INDEX "admin_audit_events_actor_user_id_created_at_idx" ON "admin_audit_events"("actor_user_id", "created_at");
CREATE INDEX "admin_audit_events_target_type_target_id_created_at_idx" ON "admin_audit_events"("target_type", "target_id", "created_at");
CREATE INDEX "admin_audit_events_tenant_id_created_at_idx" ON "admin_audit_events"("tenant_id", "created_at");

ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_recorded_by_admin_id_fkey" FOREIGN KEY ("recorded_by_admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_sales" ADD CONSTRAINT "credit_sales_credit_ledger_entry_id_fkey" FOREIGN KEY ("credit_ledger_entry_id") REFERENCES "credit_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER credit_sales_append_only BEFORE UPDATE OR DELETE ON "credit_sales"
FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER admin_audit_events_append_only BEFORE UPDATE OR DELETE ON "admin_audit_events"
FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
