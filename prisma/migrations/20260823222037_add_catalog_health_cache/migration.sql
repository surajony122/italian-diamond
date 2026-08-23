-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "catalogHealthComputedAt" TIMESTAMP(3),
ADD COLUMN     "catalogHealthStats" JSONB;

