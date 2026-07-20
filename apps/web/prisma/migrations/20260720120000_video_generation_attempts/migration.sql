CREATE TABLE "video_generation_attempts" (
    "id" UUID NOT NULL,
    "generation_job_id" UUID,
    "generation_request_id" UUID,
    "tenant_id" UUID,
    "user_id" UUID,
    "project_id" VARCHAR(80),
    "scene_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "generation_mode" TEXT NOT NULL,
    "request_snapshot" JSONB NOT NULL,
    "provider_task_id" TEXT,
    "lifecycle_state" TEXT NOT NULL,
    "poll_after" TIMESTAMPTZ(3),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "cancellation_state" TEXT NOT NULL DEFAULT 'not_requested',
    "input_hashes" JSONB NOT NULL,
    "provider_output_id" TEXT,
    "output_expires_at" TIMESTAMPTZ(3),
    "download_state" TEXT NOT NULL DEFAULT 'pending',
    "commit_state" TEXT NOT NULL DEFAULT 'pending',
    "cost_references" JSONB,
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    CONSTRAINT "video_generation_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "video_generation_attempts_generation_request_id_key" ON "video_generation_attempts"("generation_request_id");
CREATE INDEX "video_generation_attempts_lifecycle_state_poll_after_idx" ON "video_generation_attempts"("lifecycle_state", "poll_after");
CREATE INDEX "video_generation_attempts_tenant_id_created_at_idx" ON "video_generation_attempts"("tenant_id", "created_at");
CREATE INDEX "video_generation_attempts_project_id_scene_id_created_at_idx" ON "video_generation_attempts"("project_id", "scene_id", "created_at");
CREATE INDEX "video_generation_attempts_provider_provider_task_id_idx" ON "video_generation_attempts"("provider", "provider_task_id");

ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_generation_job_id_fkey" FOREIGN KEY ("generation_job_id") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_generation_request_id_fkey" FOREIGN KEY ("generation_request_id") REFERENCES "generation_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
