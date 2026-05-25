# Plan 19 — LINE インタラクティブ仕訳ヒアリング

作成日: 2026-05-25

---

## T1: Prisma マイグレーション — `Voucher.lineAnswers` 追加

**Files:** `server/prisma/schema.prisma`, `server/prisma/migrations/`

**Steps:**
1. `schema.prisma` の Voucher に `lineAnswers Json?` を追加
2. `npx prisma migrate dev --name add_voucher_line_answers`
3. `npx prisma generate`

**Commit:** `chore(spec 19): add Voucher.lineAnswers field`

---

## T2: `journal-draft-service.ts` — lineAnswers をプロンプトに組み込む

**Files:** `server/src/services/journal-draft-service.ts`

**Steps:**
1. テスト追加: lineAnswers がある場合 user payload に `追加情報` が含まれる → fail 確認
2. `voucher` select に `lineAnswers` を追加
3. `userPayload` に `追加情報: lineAnswers` を追加（空オブジェクトの場合は省略）
4. system prompt に「追加情報を最優先で使う」旨を追記
5. テスト pass 確認

**Commit:** `feat(spec 19): include lineAnswers in journal draft prompt`

---

## T3: `line-importer.ts` — needs_info 質問・回答ヒアリング実装

**Files:** `server/src/services/line-importer.ts`

**Steps:**
1. テスト追加（失敗を確認）:
   - needs_info 時に LINE push が呼ばれる
   - テキスト返信で lineAnswers が保存され再生成が呼ばれる
   - TTL 切れはキャプションにフォールバック
2. `pendingQuestionCache` と `PENDING_TTL_MS` を追加
3. `buildQuestion(field)` ヘルパーを追加
4. `sendLinePushForVoucherStatus` に `needs_info` ブランチを追加
5. `handleTextMessage` に pending チェックを追加
6. `answerPendingQuestion` async 関数を追加
7. テスト pass 確認

**Commit:** `feat(spec 19): LINE interactive journal Q&A`

---

## T4: 全テスト pass 確認 & MEMORY.md 更新

**Steps:**
1. `npm test` → 全テスト pass
2. `npx tsc --noEmit` → 既知エラー以外なし
3. MEMORY.md 更新
