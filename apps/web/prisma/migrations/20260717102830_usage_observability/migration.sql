-- CreateTable
CREATE TABLE "generation_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "project_id" VARCHAR(80),
    "scene_id" TEXT,
    "job_id" UUID,
    "idempotency_key" TEXT,
    "sequence" INTEGER NOT NULL,
    "modality" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input_metadata" JSONB,
    "output_metadata" JSONB,
    "provider_request_id" TEXT,
    "error" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "generation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL,
    "generation_request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "project_id" VARCHAR(80),
    "scene_id" TEXT,
    "job_id" UUID,
    "modality" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "usage" JSONB NOT NULL,
    "raw_usage" JSONB,
    "measurement_status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_requests_tenant_id_started_at_idx" ON "generation_requests"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "generation_requests_project_id_started_at_idx" ON "generation_requests"("project_id", "started_at");

-- CreateIndex
CREATE INDEX "generation_requests_provider_model_started_at_idx" ON "generation_requests"("provider", "model", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "generation_requests_job_id_sequence_key" ON "generation_requests"("job_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_generation_request_id_key" ON "usage_events"("generation_request_id");

-- CreateIndex
CREATE INDEX "usage_events_tenant_id_occurred_at_idx" ON "usage_events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_events_project_id_occurred_at_idx" ON "usage_events"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_events_provider_model_occurred_at_idx" ON "usage_events"("provider", "model", "occurred_at");

-- AddForeignKey
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_generation_request_id_fkey" FOREIGN KEY ("generation_request_id") REFERENCES "generation_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
