# 17a. マルチテナント データモデル — 実装プラン

作成日: 2026-05-25
対応 spec: `docs/superpowers/specs/2026-05-19-17a-multitenant-schema-design.md`

## タスク一覧

### Task 1: schema.prisma 更新

**Files**: `server/prisma/schema.prisma`

**変更内容**:

1. `Firm` モデルを追加:
```prisma
model Firm {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  isDemo    Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  members   FirmMember[]
  clients   Client[]
}
```

2. `FirmMember` モデルを追加:
```prisma
model FirmMember {
  id          String    @id @default(cuid())
  firm        Firm      @relation(fields: [firmId], references: [id], onDelete: Cascade)
  firmId      String
  authUserId  String
  role        String
  email       String
  displayName String?
  invitedAt   DateTime?
  joinedAt    DateTime?
  status      String    @default("invited")
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  @@unique([firmId, authUserId])
  @@index([authUserId])
}
```

3. 以下のモデルに `firmId String` (NOT NULL, FK to Firm) と `firm Firm @relation(...)` を追加:
   Client, VendorSync, Entry, Receipt, Matching, Task, Rule, Thread,
   YearendCheck, TrendDatum, MonthlyCheck, Voucher, VoucherInquiry,
   LineUserMapping, Integration, DriveFolderMapping, DriveWatchChannel

4. `Client` に `firm Firm @relation(fields: [firmId], references: [id], onDelete: Cascade)` を追加

5. `Integration` のユニーク制約を変更:
   - 旧: `@@unique([type])`
   - 新: `@@unique([firmId, type])`

6. `LineUserMapping` のユニーク制約を変更:
   - 旧: `lineUserId String @unique`
   - 新: `lineUserId String` + `@@unique([firmId, lineUserId])`

**Commit**: `feat(spec 17a): add Firm/FirmMember models and firmId to all tables`

---

### Task 2: Migration 作成・適用

**Files**: `server/prisma/migrations/YYYYMMDDHHMMSS_multitenant_schema/migration.sql`

CLAUDE.md の非インタラクティブ workaround を使う:

```bash
cd server
TS=$(date +%Y%m%d%H%M%S)
mkdir -p prisma/migrations/${TS}_multitenant_schema

npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script \
  > prisma/migrations/${TS}_multitenant_schema/migration.sql
```

migration.sql に以下を手動で先頭に追記（Firm テーブル作成前に firmId FK を追加できないため、順序を制御する）:

```sql
-- Create Firm and FirmMember first
-- (prisma migrate diff で生成されたものに demo-firm INSERT を追記)
INSERT INTO "Firm" (id, name, slug, "isDemo", "updatedAt")
  VALUES ('demo-firm', 'bookmee デモ事務所', 'demo', true, NOW());

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

INSERT INTO "FirmMember" (id, "firmId", "authUserId", role, email, status, "updatedAt")
  VALUES ('demo-owner', 'demo-firm', 'pending-supabase-auth-user',
          'owner', 'demo@example.com', 'active', NOW());
```

適用:
```bash
npx prisma migrate resolve --applied "${TS}_multitenant_schema"
# dev DB に直接適用
docker compose exec -T postgres psql -U bookmee -d bookmee \
  -f - < prisma/migrations/${TS}_multitenant_schema/migration.sql
npx prisma generate
```

test DB にも適用:
```bash
docker compose exec -T postgres-test psql -U bookmee -d bookmee_test \
  -f - < prisma/migrations/${TS}_multitenant_schema/migration.sql
```

**Commit**: `feat(spec 17a): migration — add firmId columns and demo-firm seed`

---

### Task 3: seed.ts 更新

**Files**: `server/prisma/seed.ts`

- `prisma.firm.upsert({ where: { id: 'demo-firm' }, ... })` を先頭に追加
- 既存の `prisma.client.upsert` に `firmId: 'demo-firm'` を追加
- Entry / Receipt / Matching 等の seed データにも `firmId: 'demo-firm'` を追加

**Commit**: `feat(spec 17a): update seed to include demo-firm`

---

### Task 4: テスト修正

**Files**: 以下のテストファイルで `prisma.<model>.create({data: {...}})` に `firmId: 'demo-firm'` を追加

- `tests/setup.ts` に `demo-firm` の upsert を追加
- `tests/services/journal-draft-service.test.ts` — `prisma.voucher.create` に firmId 追加
- `tests/services/outreach-service.test.ts` — 同上
- `tests/services/line-importer.test.ts` — `prisma.lineUserMapping.create` に firmId 追加、`prisma.voucher.findUnique` の結果確認
- `tests/services/line-mapping-service.test.ts` — firmId 追加
- `tests/routes/vouchers.test.ts` — prisma.voucher.create に firmId 追加
- `tests/routes/integrations-line.test.ts` — firmId 追加
- その他 `prisma.client.create` を使っているファイル全般

**Commit**: `test(spec 17a): add firmId: demo-firm to all test fixtures`

---

### Task 5: firm-service.ts 追加

**Files**: `server/src/services/firm-service.ts`

```ts
import { prisma } from '../lib/prisma.js';
import type { Firm } from '@prisma/client';

export async function getDemoFirmId(): Promise<string> {
  return 'demo-firm';
}

export async function listFirms(): Promise<Firm[]> {
  return prisma.firm.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function getFirm(id: string): Promise<Firm | null> {
  return prisma.firm.findUnique({ where: { id } });
}
```

テスト: `tests/services/firm-service.test.ts` (2 ケース: getDemoFirmId / listFirms)

**Commit**: `feat(spec 17a): add firm-service with getDemoFirmId/listFirms/getFirm`

---

### Task 6: voucher-service の firmId 対応

**Files**: `server/src/services/voucher-service.ts`

- `createVoucher` の引数型に `firmId?: string` を追加（省略時は `'demo-firm'`）
- `prisma.voucher.create` に `firmId` を渡す

**Commit**: `feat(spec 17a): pass firmId through createVoucher (default demo-firm)`

---

## 受入基準

- [ ] `npx prisma migrate deploy` で migration が通る
- [ ] `SELECT count(*) FROM "Firm"` で 1 件 (demo-firm)
- [ ] `SELECT count(*) FROM "Client" WHERE "firmId" IS NULL` が 0 件
- [ ] `npm test` で 133 件 (131 + firm-service 2 件) PASS
- [ ] `npx tsc --noEmit` で新規エラーなし
