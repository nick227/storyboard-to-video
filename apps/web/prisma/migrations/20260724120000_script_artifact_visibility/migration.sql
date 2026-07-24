-- Per-artifact publishing on scripts (Work identity). Screenplay keeps visibility/published_at.
ALTER TABLE "scripts"
  ADD COLUMN IF NOT EXISTS "storyboard_visibility" TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS "timeline_visibility" TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS "storyboard_published_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "timeline_published_at" TIMESTAMPTZ(3);

ALTER TABLE "scripts"
  DROP CONSTRAINT IF EXISTS "scripts_storyboard_visibility_check",
  DROP CONSTRAINT IF EXISTS "scripts_timeline_visibility_check";

ALTER TABLE "scripts"
  ADD CONSTRAINT "scripts_storyboard_visibility_check" CHECK ("storyboard_visibility" IN ('private', 'public')),
  ADD CONSTRAINT "scripts_timeline_visibility_check" CHECK ("timeline_visibility" IN ('private', 'public'));

CREATE INDEX IF NOT EXISTS "scripts_storyboard_visibility_published_at_idx"
  ON "scripts"("storyboard_visibility", "storyboard_published_at");
CREATE INDEX IF NOT EXISTS "scripts_timeline_visibility_published_at_idx"
  ON "scripts"("timeline_visibility", "timeline_published_at");
