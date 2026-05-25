-- NOTE: This migration is applied to Supabase directly (not local Docker).
-- Local test DB does not use RLS. Run via Supabase MCP apply_migration.

-- Helper function to get firm IDs for the current JWT sub
CREATE OR REPLACE FUNCTION current_firm_ids()
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT "firmId" FROM "FirmMember"
  WHERE "authUserId" = (auth.jwt() ->> 'sub')::text
    AND "status" = 'active'
$$;

ALTER TABLE "Firm" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_firm" ON "Firm"
  USING ("id" IN (SELECT current_firm_ids()));

ALTER TABLE "FirmMember" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_firm_member" ON "FirmMember"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_client" ON "Client"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "VendorSync" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_vendor_sync" ON "VendorSync"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Entry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_entry" ON "Entry"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Receipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_receipt" ON "Receipt"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Matching" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_matching" ON "Matching"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_task" ON "Task"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Rule" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_rule" ON "Rule"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Thread" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_thread" ON "Thread"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "YearendCheck" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_yearend_check" ON "YearendCheck"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "TrendDatum" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_trend_datum" ON "TrendDatum"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "MonthlyCheck" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_monthly_check" ON "MonthlyCheck"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Voucher" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_voucher" ON "Voucher"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "VoucherInquiry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_voucher_inquiry" ON "VoucherInquiry"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "LineUserMapping" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_line_user_mapping" ON "LineUserMapping"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "Integration" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_integration" ON "Integration"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "DriveFolderMapping" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_drive_folder_mapping" ON "DriveFolderMapping"
  USING ("firmId" IN (SELECT current_firm_ids()));

ALTER TABLE "DriveWatchChannel" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_drive_watch_channel" ON "DriveWatchChannel"
  USING ("firmId" IN (SELECT current_firm_ids()));
