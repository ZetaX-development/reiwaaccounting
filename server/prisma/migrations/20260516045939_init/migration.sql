-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL DEFAULT 'その他',
    "vendor" TEXT NOT NULL DEFAULT 'mf',
    "mode" TEXT NOT NULL DEFAULT 'monthly',
    "fiscalYearStart" TIMESTAMP(3) NOT NULL,
    "fiscalYearEnd" TIMESTAMP(3) NOT NULL,
    "contactPrimary" TEXT NOT NULL DEFAULT 'email',
    "contactEndpoints" JSONB NOT NULL DEFAULT '{}',
    "receiptPolicyOverrides" JSONB,
    "yearendKpi" JSONB,
    "mfAccessToken" TEXT,
    "mfRefreshToken" TEXT,
    "mfTokenExpiresAt" TIMESTAMP(3),
    "mfExternalId" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "tasksOpen" INTEGER NOT NULL DEFAULT 0,
    "risk" INTEGER NOT NULL DEFAULT 0,
    "receipt" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "diff" INTEGER NOT NULL DEFAULT 0,
    "matches" INTEGER NOT NULL DEFAULT 0,
    "ownerLabel" TEXT,
    "chatMessage" TEXT,
    "messageDraft" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorSync" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "lastSync" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ok',
    "count" INTEGER NOT NULL DEFAULT 0,
    "errorMsg" TEXT,

    CONSTRAINT "VendorSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entry" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceEntryId" TEXT,
    "account" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "taxClass" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receiptStatus" TEXT NOT NULL DEFAULT 'na',
    "score" INTEGER,
    "requestedAt" TIMESTAMP(3),
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceReceiptId" TEXT,
    "status" TEXT NOT NULL,
    "vendorRef" TEXT,
    "amount" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Matching" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "invoiceRef" TEXT NOT NULL,
    "invoiceAmount" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL,
    "diffNote" TEXT,
    "status" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Matching_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 50,
    "stage" TEXT NOT NULL DEFAULT 'awaiting_approval',
    "assignee" TEXT,
    "approver" TEXT,
    "ruleId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskHistory" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,

    CONSTRAINT "TaskHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'custom',
    "industry" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'mid',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleHit" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "target" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'matched',

    CONSTRAINT "RuleHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "preview" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "externalId" TEXT,
    "errorMsg" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptPolicy" (
    "account" TEXT NOT NULL,
    "requiresReceipt" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "exemptUnder" INTEGER,
    "notes" TEXT,

    CONSTRAINT "ReceiptPolicy_pkey" PRIMARY KEY ("account")
);

-- CreateTable
CREATE TABLE "YearendCheck" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "order" INTEGER NOT NULL,

    CONSTRAINT "YearendCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendDatum" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "prev3" JSONB NOT NULL,
    "curr" DOUBLE PRECISION NOT NULL,
    "changePct" DOUBLE PRECISION NOT NULL,
    "flag" TEXT NOT NULL,

    CONSTRAINT "TrendDatum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyCheck" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "score" INTEGER NOT NULL DEFAULT 50,

    CONSTRAINT "MonthlyCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorSync_clientId_vendor_key" ON "VendorSync"("clientId", "vendor");

-- CreateIndex
CREATE INDEX "Entry_clientId_occurredAt_idx" ON "Entry"("clientId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Entry_source_sourceEntryId_key" ON "Entry"("source", "sourceEntryId");

-- AddForeignKey
ALTER TABLE "VendorSync" ADD CONSTRAINT "VendorSync_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matching" ADD CONSTRAINT "Matching_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskHistory" ADD CONSTRAINT "TaskHistory_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleHit" ADD CONSTRAINT "RuleHit_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YearendCheck" ADD CONSTRAINT "YearendCheck_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendDatum" ADD CONSTRAINT "TrendDatum_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyCheck" ADD CONSTRAINT "MonthlyCheck_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
