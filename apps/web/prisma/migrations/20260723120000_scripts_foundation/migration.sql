-- CreateTable
CREATE TABLE "scripts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "author" TEXT NOT NULL,
    "script_text" TEXT NOT NULL DEFAULT '',
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "scripts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scripts_visibility_check" CHECK ("visibility" IN ('private', 'public'))
);

-- CreateIndex
CREATE UNIQUE INDEX "scripts_slug_key" ON "scripts"("slug");
CREATE INDEX "scripts_tenant_id_updated_at_idx" ON "scripts"("tenant_id", "updated_at");
CREATE INDEX "scripts_visibility_published_at_idx" ON "scripts"("visibility", "published_at");

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "script_id" UUID;
CREATE INDEX "projects_script_id_idx" ON "projects"("script_id");

-- Backfill: one Script per existing Project, then link
CREATE TEMP TABLE "project_script_map" (
    "project_id" VARCHAR(80) PRIMARY KEY,
    "script_id" UUID NOT NULL
);

INSERT INTO "project_script_map" ("project_id", "script_id")
SELECT "id", gen_random_uuid() FROM "projects" WHERE "script_id" IS NULL;

WITH ranked AS (
  SELECT
    m."script_id",
    p."tenant_id",
    p."created_by_user_id",
    p."title",
    p."created_at",
    p."updated_at",
    COALESCE(NULLIF(u."display_name", ''), 'Anonymous') AS "author",
    COALESCE(p."document"->>'scriptText', '') AS "script_text",
    COALESCE(
      NULLIF(
        trim(both '-' FROM lower(regexp_replace(regexp_replace(COALESCE(p."title", 'untitled'), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))),
        ''
      ),
      'untitled'
    ) AS "base_slug",
    row_number() OVER (
      PARTITION BY COALESCE(
        NULLIF(
          trim(both '-' FROM lower(regexp_replace(regexp_replace(COALESCE(p."title", 'untitled'), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))),
          ''
        ),
        'untitled'
      )
      ORDER BY p."created_at", p."id"
    ) AS rn
  FROM "projects" p
  JOIN "project_script_map" m ON m."project_id" = p."id"
  JOIN "users" u ON u."id" = p."created_by_user_id"
)
INSERT INTO "scripts" (
    "id", "tenant_id", "created_by_user_id", "title", "slug", "visibility", "author", "script_text", "published_at", "created_at", "updated_at"
)
SELECT
    "script_id",
    "tenant_id",
    "created_by_user_id",
    "title",
    CASE
        WHEN rn = 1 THEN "base_slug"
        ELSE left("base_slug", 60) || '-' || substr(replace("script_id"::text, '-', ''), 1, 8)
    END,
    'private',
    "author",
    "script_text",
    NULL,
    "created_at",
    "updated_at"
FROM ranked;

UPDATE "projects" p
SET "script_id" = m."script_id"
FROM "project_script_map" m
WHERE p."id" = m."project_id";

DROP TABLE "project_script_map";

ALTER TABLE "projects" ADD CONSTRAINT "projects_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
