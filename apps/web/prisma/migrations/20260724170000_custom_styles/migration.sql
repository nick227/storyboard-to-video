CREATE TABLE "custom_styles" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "prompt_text" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "custom_styles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "custom_styles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "custom_styles_status_check" CHECK ("status" IN ('active', 'archived'))
);

CREATE TABLE "custom_style_references" (
  "id" UUID NOT NULL,
  "style_id" UUID NOT NULL,
  "category" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "idempotency_key" TEXT,
  "source" TEXT NOT NULL DEFAULT 'user_upload',
  "prompt_snapshot" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "aspect_ratio" TEXT,
  "generation_request_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "custom_style_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "custom_style_references_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "custom_styles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "custom_style_references_category_check" CHECK ("category" IN ('characters', 'world'))
);

CREATE UNIQUE INDEX "custom_style_references_storage_key_key" ON "custom_style_references"("storage_key");
CREATE UNIQUE INDEX "custom_style_references_style_id_category_sort_order_key" ON "custom_style_references"("style_id", "category", "sort_order");
CREATE UNIQUE INDEX "custom_style_references_style_id_category_idempotency_key_key" ON "custom_style_references"("style_id", "category", "idempotency_key");
CREATE INDEX "custom_styles_user_id_status_updated_at_idx" ON "custom_styles"("user_id", "status", "updated_at");
CREATE INDEX "custom_style_references_style_id_category_sort_order_idx" ON "custom_style_references"("style_id", "category", "sort_order");
