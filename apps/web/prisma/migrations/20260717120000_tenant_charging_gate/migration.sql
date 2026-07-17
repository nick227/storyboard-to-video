ALTER TABLE "credit_accounts"
ADD COLUMN "charging_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "charging_changed_at" TIMESTAMPTZ(3),
ADD COLUMN "charging_changed_by_user_id" UUID;

CREATE INDEX "credit_accounts_charging_enabled_idx" ON "credit_accounts"("charging_enabled");

ALTER TABLE "credit_accounts"
ADD CONSTRAINT "credit_accounts_charging_changed_by_user_id_fkey"
FOREIGN KEY ("charging_changed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
