-- CreateTable
CREATE TABLE "JournalPattern" (
    "id" TEXT NOT NULL,
    "debit" TEXT NOT NULL,
    "credit" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "memoExamples" TEXT[],
    "industry" TEXT,
    "tags" TEXT[],
    "amountHint" TEXT,
    "embeddingJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalPattern_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalPattern_debit_credit_idx" ON "JournalPattern"("debit", "credit");
