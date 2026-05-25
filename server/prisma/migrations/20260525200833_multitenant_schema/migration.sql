-- CreateTable Firm
CREATE TABLE "Firm" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Firm_pkey" PRIMARY KEY ("id")
);

-- CreateTable FirmMember
CREATE TABLE "FirmMember" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "authUserId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "invitedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'invited',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirmMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Firm_slug_key" ON "Firm"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "FirmMember_firmId_authUserId_key" ON "FirmMember"("firmId", "authUserId");

-- CreateIndex
CREATE INDEX "FirmMember_authUserId_idx" ON "FirmMember"("authUserId");

-- AddForeignKey for FirmMember
ALTER TABLE "FirmMember" ADD CONSTRAINT "FirmMember_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Insert demo-firm
INSERT INTO "Firm" (id, name, slug, "isDemo", "updatedAt")
  VALUES ('demo-firm', 'bookmee デモ事務所', 'demo', true, NOW());

-- Add firmId columns as nullable first
ALTER TABLE "Client"             ADD COLUMN "firmId" TEXT;
ALTER TABLE "VendorSync"         ADD COLUMN "firmId" TEXT;
ALTER TABLE "Entry"              ADD COLUMN "firmId" TEXT;
ALTER TABLE "Receipt"            ADD COLUMN "firmId" TEXT;
ALTER TABLE "Matching"           ADD COLUMN "firmId" TEXT;
ALTER TABLE "Task"               ADD COLUMN "firmId" TEXT;
ALTER TABLE "Rule"               ADD COLUMN "firmId" TEXT;
ALTER TABLE "Thread"             ADD COLUMN "firmId" TEXT;
ALTER TABLE "YearendCheck"       ADD COLUMN "firmId" TEXT;
ALTER TABLE "TrendDatum"         ADD COLUMN "firmId" TEXT;
ALTER TABLE "MonthlyCheck"       ADD COLUMN "firmId" TEXT;
ALTER TABLE "Voucher"            ADD COLUMN "firmId" TEXT;
ALTER TABLE "VoucherInquiry"     ADD COLUMN "firmId" TEXT;
ALTER TABLE "LineUserMapping"    ADD COLUMN "firmId" TEXT;
ALTER TABLE "Integration"        ADD COLUMN "firmId" TEXT;
ALTER TABLE "DriveFolderMapping" ADD COLUMN "firmId" TEXT;
ALTER TABLE "DriveWatchChannel"  ADD COLUMN "firmId" TEXT;

-- Backfill all existing rows with demo-firm
UPDATE "Client"             SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "VendorSync"         SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Entry"              SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Receipt"            SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Matching"           SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Task"               SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Rule"               SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Thread"             SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "YearendCheck"       SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "TrendDatum"         SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "MonthlyCheck"       SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Voucher"            SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "VoucherInquiry"     SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "LineUserMapping"    SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Integration"        SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "DriveFolderMapping" SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "DriveWatchChannel"  SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;

-- Insert demo-owner FirmMember
INSERT INTO "FirmMember" (id, "firmId", "authUserId", role, email, status, "updatedAt")
  VALUES ('demo-owner', 'demo-firm', 'pending-supabase-auth-user',
          'owner', 'demo@example.com', 'active', NOW());

-- Set NOT NULL constraints
ALTER TABLE "Client"             ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "VendorSync"         ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Entry"              ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Receipt"            ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Matching"           ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Task"               ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Rule"               ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Thread"             ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "YearendCheck"       ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "TrendDatum"         ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "MonthlyCheck"       ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Voucher"            ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "VoucherInquiry"     ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "LineUserMapping"    ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Integration"        ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "DriveFolderMapping" ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "DriveWatchChannel"  ALTER COLUMN "firmId" SET NOT NULL;

-- Add foreign key constraints
ALTER TABLE "Client"             ADD CONSTRAINT "Client_firmId_fkey"             FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorSync"         ADD CONSTRAINT "VendorSync_firmId_fkey"         FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Entry"              ADD CONSTRAINT "Entry_firmId_fkey"              FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Receipt"            ADD CONSTRAINT "Receipt_firmId_fkey"            FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Matching"           ADD CONSTRAINT "Matching_firmId_fkey"           FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task"               ADD CONSTRAINT "Task_firmId_fkey"               FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Rule"               ADD CONSTRAINT "Rule_firmId_fkey"               FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Thread"             ADD CONSTRAINT "Thread_firmId_fkey"             FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YearendCheck"       ADD CONSTRAINT "YearendCheck_firmId_fkey"       FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrendDatum"         ADD CONSTRAINT "TrendDatum_firmId_fkey"         FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlyCheck"       ADD CONSTRAINT "MonthlyCheck_firmId_fkey"       FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Voucher"            ADD CONSTRAINT "Voucher_firmId_fkey"            FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoucherInquiry"     ADD CONSTRAINT "VoucherInquiry_firmId_fkey"     FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LineUserMapping"    ADD CONSTRAINT "LineUserMapping_firmId_fkey"    FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Integration"        ADD CONSTRAINT "Integration_firmId_fkey"        FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriveFolderMapping" ADD CONSTRAINT "DriveFolderMapping_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriveWatchChannel"  ADD CONSTRAINT "DriveWatchChannel_firmId_fkey"  FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Update unique constraints
DROP INDEX IF EXISTS "Integration_type_key";
CREATE UNIQUE INDEX "Integration_firmId_type_key" ON "Integration"("firmId", "type");

DROP INDEX IF EXISTS "LineUserMapping_lineUserId_key";
CREATE UNIQUE INDEX "LineUserMapping_firmId_lineUserId_key" ON "LineUserMapping"("firmId", "lineUserId");
