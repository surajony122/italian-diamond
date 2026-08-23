-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "defaultShapeMarkupPercent" DOUBLE PRECISION NOT NULL DEFAULT 25.0,
ADD COLUMN     "shapeMarkups" JSONB NOT NULL DEFAULT '{"round": 0, "emerald": 0}';

