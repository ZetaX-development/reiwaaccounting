# 14. 仕訳ドラフト生成 + 顧客問い合わせ — 実装プラン

作成日: 2026-05-25
対応 spec: `docs/superpowers/specs/2026-05-19-14-voucher-journal-draft-design.md`

## ステータス

> **実装完了**（後追い記録）。spec 14 は spec 10〜13 と同時並行で実装された。
> 本 plan は既存実装の整理と、未検証項目の確認チェックリストを兼ねる。

---

## 実装済みタスク一覧

### Task 1: Prisma スキーマ拡張

**Files**: `server/prisma/schema.prisma`

- [x] `Voucher` に `draftJournalJson Json?` を追加
- [x] `Voucher` に `journalStatus String @default("none")` を追加
- [x] `Voucher` に `inquiryAt DateTime?` を追加
- [x] `Voucher` に `inquiryChannel String?` を追加
- [x] `VoucherInquiry` モデルを追加（`id`, `voucherId`, `channel`, `target`, `body`, `sentAt`, `status`, `errorMessage`）
- [x] Migration 適用済み

**Commit**: `feat(spec 14): add draftJournalJson / journalStatus / VoucherInquiry to schema`

---

### Task 2: journal-draft-service 実装

**Files**: `server/src/services/journal-draft-service.ts`

- [x] `generateDraftJournal(voucherId)` を実装
  - `ocrJson` が不足（amount or issue_date が null）→ `journalStatus='none'` で早期 return
  - `journalStatus='drafting'` にしてから OpenAI 呼び出し
  - MF クラウド会計形式（借方/貸方）の `DraftJournalSchema` で JSON 強制
  - `missingFields.length > 0` なら `journalStatus='needs_info'`、なければ `'drafted'`
  - 失敗時は `journalStatus='none'` にリセット
- [x] `DEBIT_ACCOUNTS` / `CREDIT_ACCOUNTS` / `TAX_CLASSES` 定数でプロンプト構築
- [x] `payment_method` を優先して貸方を決める指示をシステムプロンプトに組み込み

**Commit**: `feat(spec 14): journal-draft-service — MF-style debit/credit draft generation`

---

### Task 3: outreach-service 実装

**Files**:
- `server/src/services/outreach-service.ts`
- `server/src/adapters/outreach-adapter.ts`

- [x] `OutreachAdapter` インターフェース定義
- [x] `MockOutreachAdapter` — console.log + VoucherInquiry 記録
- [x] `EmailOutreachAdapter` スケルトン — `SENDGRID_API_KEY` 未設定なら failed で記録
- [x] `LineOutreachAdapter` スケルトン（同様）
- [x] `inquireAboutVoucher(voucherId)` を実装
  - `draftJournalJson.missingFields` を取り出し
  - `env.OUTREACH_CHANNEL` でアダプタ選択
  - テンプレートメッセージ生成
  - `VoucherInquiry` 記録、`journalStatus='inquired'` 更新

**Commit**: `feat(spec 14): outreach-service + mock/email/line adapter stubs`

---

### Task 4: voucher-service トリガー連結

**Files**: `server/src/services/voucher-service.ts`

- [x] `assignAndMatchVoucher` の末尾に `setImmediate` で `generateDraftJournal` を起動
  - `matchStatus === 'unmatched'` かつ `ocrStatus === 'done'` の場合のみ
  - `OUTREACH_AUTO=true` のときは続けて `inquireAboutVoucher` も起動

**Commit**: `feat(spec 14): auto-trigger generateDraftJournal after unmatched assignment`

---

### Task 5: ルート追加

**Files**: `server/src/routes/vouchers.ts`

- [x] `POST /api/vouchers/:id/draft-journal` — 手動再生成（202）
- [x] `POST /api/vouchers/:id/inquire` — 顧客問い合わせ手動送信（202）
- [x] `PATCH /api/vouchers/:id/journal` — ドラフト手動編集（account, description, status）
- [x] `GET /api/vouchers` レスポンスに `draftJournalJson`, `journalStatus`, `inquiryAt`, `inquiryChannel` を追加

**Commit**: `feat(spec 14): add draft-journal / inquire / journal-patch routes`

---

### Task 6: フロントエンド UI 実装

**Files**: `script.js`, `styles.css`

- [x] `renderMatchingResults` の「要対応」セクションに仕訳ドラフト表示
  - 借方/貸方の MF 形式テーブル（勘定科目・補助・取引先・税区分・インボイス・金額）
  - `journalStatus` バッジ（`drafted`/`needs_info`/`inquired`/`approved`）
  - `missingFields` リスト + 「情報を依頼」ボタン
  - 「再生成」ボタン（`POST /draft-journal`）
  - 「承認」ボタン（`PATCH /journal { status: 'approved' }`）
- [x] 古い単一行フォーマット（`account`/`amount`/`taxClass`/`occurredAt`）との後方互換処理
- [x] 承認済みドラフト一覧を月次業務ビューに表示（MF 手動入力用コピペ補助）

**Commit**: `feat(spec 14): matching-results UI — MF-style draft table + approve/inquire buttons`

---

### Task 7: テスト

**Files**:
- `server/tests/services/journal-draft-service.test.ts`
- `server/tests/services/outreach-service.test.ts`
- `server/tests/routes/vouchers.test.ts`（`/draft-journal`, `/inquire`, `/journal` ケース追加）

- [x] `journal-draft-service.test.ts` — 3 ケース
  - drafted（missingFields なし）
  - needs_info（missingFields あり）
  - OCR amount 不足 → none（OpenAI 未呼び出し）
- [x] `outreach-service.test.ts` — 2 ケース
  - mock channel で sent + VoucherInquiry 記録
  - email channel（未設定）で failed + errorMessage
- [ ] `routes/vouchers.test.ts` に spec 14 追加分のケースが存在するか確認が必要

---

## 未確認・残作業

### 確認チェックリスト

- [ ] `npm test` で全テストが PASS すること（Docker 起動後に確認）
- [ ] `routes/vouchers.test.ts` に `/draft-journal`, `/inquire`, `/journal` の 3 ケースが存在するか確認
  - 存在しなければ Task 7 として追加実装
- [ ] `POST /draft-journal` が既に `journalStatus='drafted'` の voucher に対して **再生成** できること（手動再生成の冪等性）
- [ ] `PATCH /journal { status: 'approved' }` で `journalStatus` が更新されること
- [ ] フロントで「再生成」「承認」「情報を依頼」ボタンが動くこと（手動 UI 確認）

### 次アクション

1. Docker 起動後: `npm test` を実行して全件 PASS を確認
2. 失敗があれば修正（Codex に委ねる）
3. `routes/vouchers.test.ts` の spec 14 ケースが抜けていれば追加
4. plan ファイルを commit: `docs(spec 14): add implementation plan (retroactive)`

---

## コミット方針

```
docs(spec 14): add implementation plan (retroactive)
```
