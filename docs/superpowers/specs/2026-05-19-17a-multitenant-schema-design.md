# 17a. マルチテナント データモデル (認証は別 spec)

作成日: 2026-05-19

## 位置づけ

Spec 17 (マルチテナント認証 + ユーザ管理) を 2 段階に分割した前半。本 spec では **データモデルだけ** マルチテナント対応にし、認証・RLS・ログイン UI は spec 17b に分離する。

### なぜ分けたか

- 認証・RLS を一気に入れると、既存 OCR / 突合 / 仕訳ドラフトのテスト 131 件すべてに認証ヘッダ追加が要る + ローカル開発も毎回ログイン必須になる
- OCR 改善作業がまだ続く（プロンプト調整 / 新規列追加 / 学習履歴テーブル等）見込みで、その作業中に認証ロックダウンを入れると merge conflict と開発速度低下が辛い
- ただし「マルチテナント schema」を入れずに OCR 改善を続けると、後で全テーブルに firmId を遡及追加する大手術が要る → これは今のうちに済ます

「schema は今のうちに、認証は OCR 改善が落ち着いてから」のための分離。

### Spec 17b との関係

17b で以下を追加:
- Supabase Auth セットアップ + JWT 検証ミドルウェア
- RLS ポリシー全テーブル適用
- 認証バイパスリスト (webhook / health 等)
- フロント login / set-password UI
- 既存 131 テスト + 新規テストの認証ヘッダ対応

17a 単独では「全 user が全事務所のデータを見える」状態は変わらない。**Pilot 顧客に渡せるのは 17b 完了後**。

## ゴール

1. `Firm` / `FirmMember` テーブル追加
2. 既存テーブル (`Client`, `Voucher`, `Entry`, `Receipt`, `Matching`, `Task`, `Rule`, `Thread`, `YearendCheck`, `TrendDatum`, `MonthlyCheck`, `VendorSync`, `VoucherInquiry`, `LineUserMapping`, `Integration`, `DriveFolderMapping`, `DriveWatchChannel`) に `firmId String` を追加
3. 既存全データを「デモ事務所 (`demo-firm`)」に紐付ける migration
4. テスト 131 件は引き続き PASS（test seed が demo-firm を含める）
5. 新規開発（OCR 改善等）で新規テーブルを作る時は firmId を必ず入れる

## 非ゴール（17b に含まれる）

- ログイン UI / Supabase Auth セットアップ
- 認証ミドルウェア
- RLS ポリシー
- メンバー招待 API
- 既存テストへの認証ヘッダ追加
- フロント側の「自事務所のみ見える」絞り込み

## データモデル

### 新規モデル

```prisma
model Firm {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  isDemo    Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  members  FirmMember[]
  clients  Client[]
}

model FirmMember {
  id          String    @id @default(cuid())
  firm        Firm      @relation(fields: [firmId], references: [id], onDelete: Cascade)
  firmId      String
  authUserId  String                          // Supabase auth.users.id (17b で本格利用)
  role        String                          // 'owner' | 'member'
  email       String
  displayName String?
  invitedAt   DateTime?
  joinedAt    DateTime?
  status      String    @default("invited")   // 'invited' | 'active' | 'removed'
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([firmId, authUserId])
  @@index([authUserId])
}
```

`authUserId` は 17a 時点では「予約フィールド」。17b で Supabase Auth の `auth.users.id` を入れる。17a は demo-firm の Owner として `kkouta-demo` 等の placeholder を入れる。

### 既存モデルへの追加

以下に `firmId String`（外部キー、NOT NULL）を追加:

| テーブル | 備考 |
|---|---|
| Client | 主軸テーブル |
| VendorSync | Client 経由でも辿れるが検索高速化のため直持ち |
| Entry | Client 経由 |
| Receipt | Client 経由 |
| Matching | Client 経由 |
| Task | Client 経由 |
| Rule | Client 経由 |
| Thread | Client 経由 |
| YearendCheck | Client 経由 |
| TrendDatum | Client 経由 |
| MonthlyCheck | Client 経由 |
| Voucher | Client が nullable なので firm を直持ち |
| VoucherInquiry | Voucher 経由でも辿れるが firm 直持ち |
| LineUserMapping | スタッフ単位、firm 直 |
| Integration | firm 単位の連携 |
| DriveFolderMapping | Client + firm 両方 |
| DriveWatchChannel | firm 単位 |

`TaskHistory` / `RuleHit` は親 (`Task` / `Rule`) 経由で firmId に辿れるので直追加しない（ストレージ最適化）。`ReceiptPolicy` はグローバル設定として残す（firmId なし）。

### ユニーク制約の変更

```prisma
model Integration {
  // 旧: @@unique([type])
  @@unique([firmId, type])
}

model LineUserMapping {
  // 旧: lineUserId @unique
  // 新: 同じ LINE user が複数事務所で別スタッフ扱いになる可能性を許容
  @@unique([firmId, lineUserId])
  // lineUserId 単独の unique は削除
}
```

その他のテーブルは firmId 追加のみで unique 制約変更なし。

## 既存データ移行 SQL (抜粋)

```sql
-- 1. Firm / FirmMember テーブル作成
CREATE TABLE "Firm" (...);
CREATE TABLE "FirmMember" (...);

-- 2. デモ事務所作成
INSERT INTO "Firm" (id, name, slug, "isDemo", "updatedAt")
  VALUES ('demo-firm', 'bookmee デモ事務所', 'demo', true, NOW());

-- 3. 全テーブルに firmId 列を NULL 許容で追加
ALTER TABLE "Client" ADD COLUMN "firmId" TEXT;
ALTER TABLE "Voucher" ADD COLUMN "firmId" TEXT;
-- ... (全テーブル分)

-- 4. 既存レコードをデモ事務所に紐付け
UPDATE "Client" SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "Voucher" SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
-- ... (全テーブル分)

-- 5. NOT NULL + 外部キー
ALTER TABLE "Client" ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Client" ADD CONSTRAINT "Client_firmId_fkey"
  FOREIGN KEY ("firmId") REFERENCES "Firm"(id) ON DELETE CASCADE;
-- ... (全テーブル分)

-- 6. unique 制約変更
ALTER TABLE "Integration" DROP CONSTRAINT "Integration_type_key";
CREATE UNIQUE INDEX "Integration_firmId_type_key"
  ON "Integration"("firmId", "type");

ALTER TABLE "LineUserMapping" DROP CONSTRAINT "LineUserMapping_lineUserId_key";
CREATE UNIQUE INDEX "LineUserMapping_firmId_lineUserId_key"
  ON "LineUserMapping"("firmId", "lineUserId");

-- 7. demo-firm の placeholder Owner を作る
INSERT INTO "FirmMember" (id, "firmId", "authUserId", role, email, status, "updatedAt")
  VALUES ('demo-owner', 'demo-firm', 'pending-supabase-auth-user',
          'owner', 'kkouta@example.com', 'active', NOW());
```

## サービス層の変更

新規ファイル `services/firm-service.ts`（ただし 17a では最小限の関数のみ）:

```ts
export async function getDemoFirmId(): Promise<string> {
  return 'demo-firm';
}

export async function listFirms(): Promise<Firm[]>;
export async function getFirm(id: string): Promise<Firm | null>;
```

既存サービス (`voucher-service.ts`, `client-service.ts` 等) は **17a では基本的に変更しない**。新規テーブルで firmId が NOT NULL になったので、Prisma の `create` 時に `firmId` を渡す必要がある箇所だけ更新する。具体的には:

- `voucher-service.createVoucher` → 引数に `firmId` を追加（呼び出し元はとりあえず `'demo-firm'` 固定）
- `voucher-assign-service.ts` で AI が選ぶ Client は demo-firm のものに限定（既存挙動と同じ）
- `client-service.ts` の getClientById 等 → firmId フィルタ無し（全 client が demo-firm 配下なので動く）

つまり「`firmId` 列はあるが現状は demo-firm 一択」状態。

## テストへの影響

- 既存 131 テストはほぼそのまま動く（test seed の DB は demo-firm を含めるよう更新）
- `tests/setup.ts` に「test 用 demo-firm をシードする」処理を追加
- 各テストファイルで `prisma.client.create({...})` してる箇所は `firmId: 'demo-firm'` を追加
- 新規テスト `tests/services/firm-service.test.ts` (2 ケース: listFirms / getDemoFirmId)

## 受入基準

- [ ] migration 適用後、`SELECT count(*) FROM "Firm"` で 1 件 (demo-firm)
- [ ] `SELECT count(*) FROM "Client" WHERE "firmId" IS NULL` が 0 件
- [ ] 既存テスト 131 件 + 新規 2 件 = 133 件 PASS
- [ ] dev サーバ起動 → ブラウザで既存 UI が今まで通り動く（顧問先 / 月次業務 / 突合結果 / 連携 全部）
- [ ] `npx tsc --noEmit` で新規エラーなし

## 17a が完了した時点の状態

- DB 構造上は「複数事務所が同居できる」が、データは demo-firm 1 つだけ
- 認証は無いので誰でも全データ操作可能（現状と同じ）
- OCR / Drive / LINE / 仕訳ドラフトは引き続き動く
- 新規テーブルや列を足す時は firmId を含める習慣を入れる

## 17b で着手するもの (本 spec 範囲外)

- Supabase プロジェクト作成 + Auth 設定
- Email/password + Google OAuth ログイン
- 認証ミドルウェア + JWT 検証
- RLS ポリシー全テーブル適用
- 招待メール送信 + Owner 招待
- メンバー管理 UI
- 既存 131 テストへの認証ヘッダ対応
- フロント login / set-password 画面
- パイロット顧客への配布
