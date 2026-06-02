# spec 29: メール証憑問い合わせの双方向化（レシート添付＋返信→再仕訳）

- 日付: 2026-06-02
- ステータス: design
- 関連: spec 28（web/drive 証憑メール送信）, spec 19（LINE 返信→再ドラフト）

## 目的

spec 28 で web/drive 証憑の不足情報を Resend メールで送れるようにした。これを**双方向**にする:

- **Part A**: 送信する確認メールに**レシート写真を添付**する（顧客が何の証憑か分かるように）。
- **Part B**: 顧客の**返信を取り込み、その内容を踏まえて仕訳ドラフトを作り直す**（LINE と同等の体験をメールでも）。

LINE は既に「返信→`generateDraftJournal` 再ドラフト」が動いている（spec 19）。メールでも同じ再ドラフト基盤を流用する。

## 非ゴール / 割り切り

- **本物のメール受信は作らない**。Resend Inbound（独自ドメイン検証）や Gmail ポーリングは行わず、**疑似受信エンドポイント＋UI**で返信本文を渡す方式にする（依存ゼロ、デモで往復ループを見せられる）。将来 `POST /api/integrations/email/inbound` 等の本物受信に差し替え可能な形にする。
- 返信本文から**個別フィールドを構造抽出しない**。返信を丸ごと「追加情報」として再ドラフト AI に渡す（シンプル・堅牢）。
- 宛先は spec 28 同様ハードコード `kkouta2017@gmail.com`（将来 `contactEndpoints.email` へ。TODO 継続）。

## 設計

### Part A: 送信メールにレシート写真を添付

`adapters/outreach-adapter.ts`:
- `OutreachAdapter.send` に任意引数 `attachments?: OutreachAttachment[]` を追加。
  ```ts
  interface OutreachAttachment { filename: string; content: string; /* base64 */ contentType: string }
  ```
- `EmailOutreachAdapter`:
  - Resend 分岐: payload に `attachments: [{ filename, content }]`（content=base64）を、添付があるときだけ追加。
  - SendGrid 分岐: `attachments: [{ content, filename, type: contentType, disposition: 'attachment' }]`。
- `MockOutreachAdapter` / `LineOutreachAdapter`: 引数は受け取るが無視（メール専用機能）。

`services/outreach-service.ts` `inquireAboutVoucher`:
- Voucher 取得時に `imageData / filename / mimeType` を select。
- `imageData` を base64 化し `attachments=[{ filename, content, contentType: mimeType }]` を作って `adapter.send(target, subject, body, attachments)` に渡す。
- 画像が無い場合は添付なしで送る。

### Part B: 返信取り込み → 再仕訳（疑似受信）

新ファイル `services/voucher-reply-service.ts`:
- `applyVoucherReply(voucherId: string, text: string): Promise<boolean>`
  - voucher を取得（無ければ false）。
  - 既存の回答マップ（`Voucher.lineAnswers`、**実質チャネル非依存の回答マップとして再利用**。将来 `answers` にリネーム推奨）に `{ ...existing, メール返信: text }` をマージ保存。
  - `generateDraftJournal(voucherId)` を呼んで再ドラフト（既存実装が `lineAnswers` を `追加情報` として AI に注入）。
  - true を返す。

新ルート `routes/vouchers.ts`:
- `POST /api/vouchers/:id/email-reply`、body `{ text: string }`。`applyVoucherReply` を呼び `{ ok: true }` を返す。空 text は 400。

UI（`script.js`）:
- 証憑カード（spec 14 のドラフト表示部、`data-matching-inquire` ボタン付近）に、**返信貼り付け用の textarea ＋「返信を取り込む」ボタン**（`data-voucher-reply="<id>"`）を追加。
- クリックで `POST /api/vouchers/:id/email-reply` → 成功で証憑一覧を再読込し、更新後のドラフトを表示。Vanilla JS なので `node --check` ＋手動確認。

## テスト方針

- `tests/adapters/outreach-adapter.test.ts`: RESEND キー設定時、`attachments` を渡すと Resend payload に `attachments:[{filename, content}]` が入る。
- `tests/services/voucher-reply-service.test.ts`（実 Postgres、`generateDraftJournal` は `vi.mock` でモック）:
  - `applyVoucherReply` 後、`Voucher.lineAnswers['メール返信']` に本文が保存される。
  - `generateDraftJournal` が当該 voucherId で呼ばれる。
  - 存在しない voucherId は false。
- 既存テスト（outreach-adapter / outreach-service）が壊れないこと。

## 受入基準

1. web/drive 証憑の確認メールに**レシート画像が添付**されて kkouta2017 に届く。
2. `POST /api/vouchers/:id/email-reply`（または UI の「返信を取り込む」）に返信本文を渡すと、`lineAnswers` に保存され `generateDraftJournal` が再実行され、**返信内容を踏まえた仕訳ドラフト**に更新される。
3. `npm test` 全 green。`node --check script.js` が通る。
4. spec/コードに「lineAnswers はチャネル非依存の回答マップとして再利用（将来 answers にリネーム）」「宛先ハードコードは将来 contactEndpoints.email へ」の TODO が残る。
