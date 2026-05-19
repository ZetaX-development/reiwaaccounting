# 14. 未突合 Voucher の仕訳ドラフト生成 + 顧客への追加情報依頼

作成日: 2026-05-19

## 位置づけ

spec 12 で突合できなかった Voucher（OCR 完了済みだが MF 仕訳と一致なし）に対し、

1. AI で **仕訳ドラフト** を生成（勘定科目・税区分・摘要・金額・発生日）
2. ドラフト生成に必要な情報が **不足** している場合は、顧客にメール/LINE で確認依頼
3. ドラフトは zeimee 内に保管（MF への書き戻しは **禁止**、spec 08 / 10 で確定済み）。事務所スタッフが「突合結果」ビューでレビュー後、MF 側で手動入力する想定

A→B→C→D に続く **E** のフェーズ。

## ゴール

1. matchStatus='unmatched' かつ ocrStatus='done' → 自動でドラフト生成
2. ドラフトに `missingFields` がある場合、自動 or ボタン操作で顧客に問い合わせメッセージを送る
3. メール・LINE のアダプタは **インターフェースだけ用意**、実体はモック。user が並行作業で接続する SendGrid/LINEWORKS 等を後から差し込める
4. 「突合結果」ビューに「仕訳ドラフト」セクションを追加して可視化
5. zeimee → MF への書き戻しは **しない**（read-only）

## アクター

- **税理士事務所スタッフ**: ドラフトをレビュー、必要なら自分で MF に転記、問い合わせを送る/もらった返信を反映
- **顧問先（クライアント）**: メール/LINE で「この経費の目的は？」「相手は誰？」などに返答（返答 UI は本スペック外）

## トリガー

| パターン | 動作 |
|---|---|
| 自動（メイン） | `assignAndMatchVoucher` が `unmatched` で終わった直後、`generateDraftJournal` を setImmediate でキック |
| 手動（再生成） | POST /api/vouchers/:id/draft-journal で再実行 |
| 顧客問い合わせ（自動） | ドラフトに missingFields があり、かつ `OUTREACH_AUTO=true` のとき送信 |
| 顧客問い合わせ（手動） | UI の「情報を依頼」ボタンから POST /api/vouchers/:id/inquire |

## データモデル拡張

```prisma
model Voucher {
  // ... 既存
  draftJournalJson  Json?     // 生成された仕訳ドラフト
  journalStatus     String   @default("none")
  // 'none'         初期 / 突合済みなのでドラフト不要
  // 'drafting'     生成中
  // 'drafted'      生成済 (情報充足)
  // 'needs_info'   ドラフトに missingFields あり
  // 'inquired'     顧客へ問い合わせ送信済み
  // 'approved'     スタッフが承認 (= MF に手動転記済み or 確定)
  inquiryAt         DateTime?
  inquiryChannel    String?   // 'email' | 'line' | 'mock'
  inquiries         VoucherInquiry[]
}

model VoucherInquiry {
  id           String   @id @default(cuid())
  voucher      Voucher  @relation(fields: [voucherId], references: [id], onDelete: Cascade)
  voucherId    String
  channel      String   // 'email' | 'line' | 'mock'
  target       String   // 送信先 (email アドレス / LINE userId)
  body         String   // 送信本文
  sentAt       DateTime @default(now())
  status       String   @default("sent")  // 'sent' | 'failed'
  errorMessage String?

  @@index([voucherId])
}
```

`draftJournalJson` のスキーマ:

```ts
{
  account: string,         // 勘定科目 (例: "旅費交通費", "消耗品費")
  taxClass: string | null, // 税区分 (例: "課税仕入10%")
  description: string,     // 摘要 (例: "出張先での昼食代")
  amount: number,
  occurredAt: string,      // YYYY-MM-DD
  missingFields: string[], // ['purpose', 'attendees', ...] 等
  reasoning: string,       // AI による科目選定の根拠 (デバッグ用)
}
```

## 仕訳ドラフト生成サービス (`services/journal-draft-service.ts`)

```ts
export async function generateDraftJournal(
  voucherId: string,
): Promise<void>;
```

ステップ:
1. Voucher を読む（ocrJson 必須）
2. `journalStatus = 'drafting'` に更新
3. OpenAI に
   - 入力: vendor_name, addressee, amount, issue_date, invoice_number, 顧問先の業種
   - 指示: 「日本の中小企業の経費として、最も妥当な勘定科目・税区分・摘要・発生日を提案する。判断に追加情報が必要な場合は `missingFields` に何が足りないかを書く」
   - JSON schema 強制
   - モデル: env.OPENAI_VISION_MODEL (gpt-5)
4. 結果を `draftJournalJson` に保存、`journalStatus = 'drafted'`（missingFields=空）or `'needs_info'`（あり）

候補科目はプロンプトで提示する（10〜15個のメジャーな科目）。

## 顧客問い合わせサービス (`services/outreach-service.ts`)

```ts
export interface OutreachAdapter {
  readonly channel: 'email' | 'line' | 'mock';
  send(target: string, subject: string, body: string): Promise<{ ok: boolean; error?: string }>;
}

export async function inquireAboutVoucher(voucherId: string): Promise<void>;
```

`inquireAboutVoucher` の中身:
1. Voucher を読む。`draftJournalJson?.missingFields` を取得
2. その顧問先の `Client.contactEndpoints` から送信先を決定（既存仕様）
3. `env.OUTREACH_CHANNEL` で選んだアダプタを使う
4. body を生成（テンプレート）:

```
[zeimee] {client.name} 様

お預かりした領収書について、以下の情報を教えていただけますでしょうか:

- 発行: {vendor_name}
- 日付: {issue_date}
- 金額: ¥{amount}

確認事項:
{missingFields をリスト化}

ご返信は本メール/LINE に直接ご返信ください。
```

5. アダプタの `send` を呼ぶ
6. 結果を `VoucherInquiry` に記録、Voucher の `journalStatus = 'inquired'`, `inquiryAt`, `inquiryChannel` を更新

## アダプタ実装

| Channel | 実装 |
|---|---|
| `mock` | console.log + VoucherInquiry に記録するだけ（テスト・開発時のデフォルト） |
| `email` | **インターフェースのみ**。実装スケルトン `EmailOutreachAdapter` を作るが `send` は `throw new Error('email adapter not configured')`。`SENDGRID_API_KEY` 等を見て接続実装は user 担当 |
| `line` | 同様にスケルトンのみ |

`env.OUTREACH_CHANNEL` のデフォルトは `mock`。

## 環境変数

```
OUTREACH_CHANNEL=mock           # 'mock' | 'email' | 'line'
OUTREACH_AUTO=false             # true で missingFields ありの voucher を自動で問い合わせ
# email 用 (user 接続予定)
OUTREACH_EMAIL_FROM=zeimee@example.com
SENDGRID_API_KEY=               # 既存だが流用可
# line 用 (user 接続予定)
OUTREACH_LINE_TOKEN=
```

## ルート追加

| メソッド | パス | 役割 |
|---|---|---|
| POST | `/api/vouchers/:id/draft-journal` | 仕訳ドラフトを再生成 (202) |
| POST | `/api/vouchers/:id/inquire` | 顧客に問い合わせを送信 (202) |
| PATCH | `/api/vouchers/:id/journal` | スタッフがドラフトを手編集 (account, description 等) |

GET /api/vouchers のレスポンスに以下を追加:
- `draftJournalJson`
- `journalStatus`
- `inquiryAt`
- `inquiryChannel`

## フロント変更

### 突合結果ビュー (`renderMatchingResults`)

「⚠ 要対応」セクションの未突合カードに追加:

```
+--------------------------------------------------+
| [サムネ] ¥3,200 / ハラペコステーキ / 2026-05-15  |
+--------------------------------------------------+
| 📝 仕訳ドラフト (drafted)                        |
|   勘定科目: 接待交際費                            |
|   税区分: 課税仕入10%                            |
|   摘要: 取引先との会食 (要確認)                  |
|   [編集] [承認]                                  |
+--------------------------------------------------+
| ⚠ 不足情報あり                                  |
|   - 会食の参加者                                  |
|   - 経費目的                                      |
|   [情報を依頼]                                    |
+--------------------------------------------------+
```

ステータス別バッジ:
- `drafted` (緑) — 情報充足、レビューOK
- `needs_info` (橙) — 不足情報あり
- `inquired` (青) — 問い合わせ済み (`inquiryAt` 表示)
- `approved` (灰) — 承認済み

### appState 追加

特に追加なし（matchingVouchers から直接使う）。

### 「情報を依頼」ボタン

POST /api/vouchers/:id/inquire → 完了後リロード。

### 「承認」ボタン

PATCH /api/vouchers/:id/journal { status: 'approved' }。

## テスト

- `journal-draft-service.test.ts` — OpenAI mock で 3 ケース（drafted / needs_info / 失敗）
- `outreach-service.test.ts` — mock adapter で 2 ケース（送信成功 / アダプタなしで失敗）
- `routes/vouchers.test.ts` に 3 新規ケース（POST /draft-journal, /inquire, PATCH /journal）

## 受入基準

- [ ] 突合できない voucher に対し、自動で仕訳ドラフトが生成される
- [ ] 「突合結果 > 要対応」セクションでドラフトの勘定科目・税区分・摘要が見える
- [ ] missingFields がある場合、「情報を依頼」ボタンが表示される
- [ ] ボタン押下で `VoucherInquiry` レコードが作られ、mock channel ならログに送信内容が出る
- [ ] スタッフが PATCH で内容を編集できる
- [ ] スタッフが「承認」ボタンで journalStatus='approved' にできる
- [ ] OUTREACH_CHANNEL=email/line にすると EmailOutreachAdapter / LineOutreachAdapter が呼ばれる（実体は user が後で実装）

## 非ゴール

- MF への自動書き戻し（read-only ポリシー）
- 顧客返信の自動取り込み (inbound email/LINE webhook)
- 仕訳の CSV/JSON エクスポート（次フェーズ）
- 複数 voucher のバルク承認

## メモ: なぜ MF に書かないか

spec 08 で zeimee は read-only と決めた。書き戻しは API スコープが `*.write` を要求し、誤書き込みのリスクが高い。事務所内部で「ドラフト確定 → 担当者が MF UI に手動入力」の運用に倒す。CSV エクスポートは将来の課題。
