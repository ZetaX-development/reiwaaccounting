-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "draftJournalJson" JSONB,
ADD COLUMN     "inquiryAt" TIMESTAMP(3),
ADD COLUMN     "inquiryChannel" TEXT,
ADD COLUMN     "journalStatus" TEXT NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "VoucherInquiry" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "errorMessage" TEXT,

    CONSTRAINT "VoucherInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoucherInquiry_voucherId_idx" ON "VoucherInquiry"("voucherId");

-- AddForeignKey
ALTER TABLE "VoucherInquiry" ADD CONSTRAINT "VoucherInquiry_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
