-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "attribution_text" TEXT,
ADD COLUMN     "commercial_use_allowed" BOOLEAN,
ADD COLUMN     "creator" TEXT,
ADD COLUMN     "license_code" TEXT,
ADD COLUMN     "license_url" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "source_id" TEXT,
ADD COLUMN     "source_page_url" TEXT;

