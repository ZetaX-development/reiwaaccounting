-- Spec 23/24/25: consulting features (TaxSuggestion, CashFlowForecast, ClientPortal)

CREATE TABLE "TaxSuggestion" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "estimatedSaving" INTEGER,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CashFlowForecast" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "forecastMonth" TEXT NOT NULL,
    "inflow" INTEGER NOT NULL,
    "outflow" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "aiComment" TEXT,
    "confidence" DOUBLE PRECISION,
    "isActual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashFlowForecast_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClientPortal" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientPortal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaxSuggestion_clientId_status_idx" ON "TaxSuggestion"("clientId", "status");
CREATE INDEX "TaxSuggestion_firmId_idx" ON "TaxSuggestion"("firmId");
CREATE INDEX "CashFlowForecast_clientId_idx" ON "CashFlowForecast"("clientId");
CREATE UNIQUE INDEX "CashFlowForecast_clientId_forecastMonth_key" ON "CashFlowForecast"("clientId", "forecastMonth");
CREATE UNIQUE INDEX "ClientPortal_clientId_key" ON "ClientPortal"("clientId");
CREATE UNIQUE INDEX "ClientPortal_token_key" ON "ClientPortal"("token");

ALTER TABLE "TaxSuggestion" ADD CONSTRAINT "TaxSuggestion_firmId_fkey"
    FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashFlowForecast" ADD CONSTRAINT "CashFlowForecast_firmId_fkey"
    FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientPortal" ADD CONSTRAINT "ClientPortal_firmId_fkey"
    FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
