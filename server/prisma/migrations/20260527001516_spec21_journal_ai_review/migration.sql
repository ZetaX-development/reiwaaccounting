-- CreateTable
CREATE TABLE "JournalAiReview" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "mfJournalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "aiMemo" TEXT,
    "aiConfidence" DOUBLE PRECISION,
    "debitAccount" TEXT,
    "creditAccount" TEXT,
    "amount" INTEGER,
    "transactionDate" TEXT,
    "originalMemo" TEXT,
    "errorMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalAiReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalAiReview_firmId_status_idx" ON "JournalAiReview"("firmId", "status");

-- CreateIndex
CREATE INDEX "JournalAiReview_clientId_idx" ON "JournalAiReview"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalAiReview_clientId_mfJournalId_key" ON "JournalAiReview"("clientId", "mfJournalId");

-- AddForeignKey
ALTER TABLE "JournalAiReview" ADD CONSTRAINT "JournalAiReview_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

