-- AlterTable: add settings column to Firm
ALTER TABLE "Firm" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';
