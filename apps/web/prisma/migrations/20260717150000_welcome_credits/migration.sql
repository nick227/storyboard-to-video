CREATE TABLE "welcome_credit_policy_versions" (
  "id" UUID NOT NULL,
  "version_key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "credit_micros" BIGINT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "effective_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retired_at" TIMESTAMPTZ(3),
  "created_by_admin_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "welcome_credit_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "welcome_credit_policy_credit_positive" CHECK ("credit_micros" > 0)
);

CREATE UNIQUE INDEX "welcome_credit_policy_versions_version_key_key" ON "welcome_credit_policy_versions"("version_key");
CREATE UNIQUE INDEX "welcome_credit_policy_one_active" ON "welcome_credit_policy_versions"("active") WHERE "active" = true;
CREATE INDEX "welcome_credit_policy_versions_active_effective_at_idx" ON "welcome_credit_policy_versions"("active", "effective_at");

ALTER TABLE "welcome_credit_policy_versions" ADD CONSTRAINT "welcome_credit_policy_versions_created_by_admin_id_fkey"
  FOREIGN KEY ("created_by_admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_ledger_entries" ADD COLUMN "welcome_credit_policy_version_id" UUID;
CREATE INDEX "credit_ledger_entries_welcome_credit_policy_version_id_idx" ON "credit_ledger_entries"("welcome_credit_policy_version_id");
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_welcome_credit_policy_version_id_fkey"
  FOREIGN KEY ("welcome_credit_policy_version_id") REFERENCES "welcome_credit_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION protect_welcome_credit_policy_terms() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'welcome credit policy versions are immutable'; END IF;
  IF NEW.version_key <> OLD.version_key OR NEW.name <> OLD.name OR NEW.credit_micros <> OLD.credit_micros OR
     NEW.effective_at <> OLD.effective_at OR NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'welcome credit policy terms are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER welcome_credit_policy_terms_immutable BEFORE UPDATE OR DELETE ON "welcome_credit_policy_versions"
FOR EACH ROW EXECUTE FUNCTION protect_welcome_credit_policy_terms();

-- Development bootstrap value: 1,000 site credits. Administrators replace this
-- with a new active immutable version as real full-scene pricing is validated.
INSERT INTO "welcome_credit_policy_versions" (
  "id", "version_key", "name", "credit_micros", "active", "effective_at"
) VALUES (
  '20000000-0000-4000-8000-000000000001', 'welcome-v1', 'Initial free-user credits', 1000000000, true, CURRENT_TIMESTAMP
);
