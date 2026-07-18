-- CreateTable
CREATE TABLE "generation_cache_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "fingerprint_hash" CHAR(64) NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "prompt_template_version" INTEGER NOT NULL,
    "source_digest" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "bypassed" BOOLEAN NOT NULL DEFAULT false,
    "served_from_entry_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_cache_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_cache_entries_tenant_id_fingerprint_hash_created_idx" ON "generation_cache_entries"("tenant_id", "fingerprint_hash", "created_at");

-- AddForeignKey
ALTER TABLE "generation_cache_entries" ADD CONSTRAINT "generation_cache_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
