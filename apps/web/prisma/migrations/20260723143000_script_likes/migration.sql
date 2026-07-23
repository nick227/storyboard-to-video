CREATE TABLE "script_likes" (
    "script_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "script_likes_pkey" PRIMARY KEY ("script_id", "user_id")
);

CREATE INDEX "script_likes_user_id_created_at_idx" ON "script_likes"("user_id", "created_at");
CREATE INDEX "scripts_created_by_user_id_visibility_published_at_idx" ON "scripts"("created_by_user_id", "visibility", "published_at");

ALTER TABLE "script_likes" ADD CONSTRAINT "script_likes_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "script_likes" ADD CONSTRAINT "script_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
