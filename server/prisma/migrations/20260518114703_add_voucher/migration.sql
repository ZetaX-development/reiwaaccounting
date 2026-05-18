-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "imageData" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT,
    "ocrJson" JSONB,
    "ocrStatus" TEXT NOT NULL DEFAULT 'pending',
    "ocrAt" TIMESTAMP(3),
    "matchedEntryId" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Voucher_clientId_uploadedAt_idx" ON "Voucher"("clientId", "uploadedAt");

-- CreateIndex
CREATE INDEX "Voucher_ocrStatus_idx" ON "Voucher"("ocrStatus");

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
