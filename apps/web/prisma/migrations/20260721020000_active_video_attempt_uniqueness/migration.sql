ALTER TABLE "video_generation_attempts"
ADD COLUMN "request_fingerprint" VARCHAR(64);

-- Terminal attempts are deliberately excluded: a scene may be regenerated after a prior attempt
-- commits, fails, or is cancelled. PostgreSQL enforces the nonterminal invariant atomically across
-- processes and replicas; application-level find-then-create checks are only a fast path.
CREATE UNIQUE INDEX "video_generation_attempts_one_active_scene_provider_idx"
ON "video_generation_attempts" ("tenant_id", "project_id", "scene_id", "provider")
WHERE "tenant_id" IS NOT NULL
  AND "project_id" IS NOT NULL
  AND "scene_id" IS NOT NULL
  AND "lifecycle_state" IN ('preparing_assets', 'queued', 'submitted', 'provider_running', 'downloading', 'validating');
