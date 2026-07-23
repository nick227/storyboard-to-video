ALTER TABLE "users" ADD COLUMN "profile_slug" TEXT;
ALTER TABLE "users" ADD COLUMN "bio" VARCHAR(500) NOT NULL DEFAULT '';

WITH ranked AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(trim(both '-' FROM lower(regexp_replace(regexp_replace(COALESCE("display_name", 'writer'), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))), ''),
      'writer'
    ) AS base_slug,
    row_number() OVER (
      PARTITION BY COALESCE(
        NULLIF(trim(both '-' FROM lower(regexp_replace(regexp_replace(COALESCE("display_name", 'writer'), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))), ''),
        'writer'
      )
      ORDER BY "created_at", "id"
    ) AS rn
  FROM "users"
)
UPDATE "users" u
SET "profile_slug" = CASE
  WHEN ranked.rn = 1 THEN ranked.base_slug
  ELSE left(ranked.base_slug, 60) || '-' || substr(replace(u."id"::text, '-', ''), 1, 8)
END
FROM ranked
WHERE u."id" = ranked."id";

CREATE UNIQUE INDEX "users_profile_slug_key" ON "users"("profile_slug");

CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tags_slug_key" ON "tags"("slug");

ALTER TABLE "scripts" ADD COLUMN "category_id" UUID;
ALTER TABLE "scripts" ADD COLUMN "logline" VARCHAR(280) NOT NULL DEFAULT '';
CREATE INDEX "scripts_category_id_visibility_published_at_idx" ON "scripts"("category_id", "visibility", "published_at");

CREATE TABLE "script_tags" (
    "script_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    CONSTRAINT "script_tags_pkey" PRIMARY KEY ("script_id", "tag_id")
);
CREATE INDEX "script_tags_tag_id_idx" ON "script_tags"("tag_id");

CREATE TABLE "writer_follows" (
    "follower_user_id" UUID NOT NULL,
    "following_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "writer_follows_pkey" PRIMARY KEY ("follower_user_id", "following_user_id")
);
CREATE INDEX "writer_follows_following_user_id_created_at_idx" ON "writer_follows"("following_user_id", "created_at");

CREATE TABLE "script_views" (
    "id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "viewer_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "script_views_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "script_views_script_id_created_at_idx" ON "script_views"("script_id", "created_at");
CREATE INDEX "script_views_viewer_user_id_created_at_idx" ON "script_views"("viewer_user_id", "created_at");

INSERT INTO "categories" ("id", "slug", "name", "sort_order") VALUES
  ('11111111-1111-4111-8111-111111111101', 'feature', 'Feature', 10),
  ('11111111-1111-4111-8111-111111111102', 'short', 'Short', 20),
  ('11111111-1111-4111-8111-111111111103', 'pilot', 'Pilot', 30),
  ('11111111-1111-4111-8111-111111111104', 'web-series', 'Web Series', 40),
  ('11111111-1111-4111-8111-111111111105', 'other', 'Other', 90);

ALTER TABLE "scripts" ADD CONSTRAINT "scripts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "script_tags" ADD CONSTRAINT "script_tags_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "script_tags" ADD CONSTRAINT "script_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "writer_follows" ADD CONSTRAINT "writer_follows_follower_user_id_fkey" FOREIGN KEY ("follower_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "writer_follows" ADD CONSTRAINT "writer_follows_following_user_id_fkey" FOREIGN KEY ("following_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "script_views" ADD CONSTRAINT "script_views_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "script_views" ADD CONSTRAINT "script_views_viewer_user_id_fkey" FOREIGN KEY ("viewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
