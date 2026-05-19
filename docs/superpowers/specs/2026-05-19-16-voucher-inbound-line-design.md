# 16. 証憑入力チャネル拡張 — 公式 LINE Messaging API（スタッフ用）

作成日: 2026-05-19

## 位置づけ

ユーザ要望: 事務所のスタッフが、顧問先から受け取った紙のレシートを業務中に撮って **LINE 公式アカウント** に送るだけで、bookmee が自動で OCR → 顧問先振り分け → 仕訳ドラフト → 突合まで進める仕組み。bookmee 側で確認が必要な時は LINE 上でスタッフに質問を投げ、スタッフはボタンを押すだけで応答できる。

LINE 公式アカウント = LINE の Messaging API（一般ユーザが普段使う LINE）。LINE WORKS（業務 LINE、別商品）とは別物。

### 既存スペックとの関係

- spec 10（証憑登録）: ブラウザでのドラッグ&ドロップアップロードを実装済。本 spec は **別経路（LINE）から Voucher を作る** だけで、Voucher 以降のパイプラインは触らない
- spec 11（OCR）/ spec 12（突合）/ spec 14（journal draft）: LINE 経由で作られた Voucher も同パイプラインを通る。追加実装は不要
- spec 14（journal-draft）が「メール / LINE で確認依頼」を outreach 概念として定義しつつ「LINE は実体モック」「inbound webhook はスコープ外」と明記していたので、本 spec が **inbound 実装と Push 実装の両方** を担う
- spec 15（Google Drive）の Voucher 拡張（`source` 列）と同じカラムを使う。本 spec が先に実装される場合は本 spec で `source` を初出させる
- spec 03 / spec 09 の「LINE WORKS で顧問先連絡」は将来 spec 17（顧問先向け LINE）で公式 LINE に切り替える。本 spec はスタッフ用途のみ

## ゴール（ユーザから見た機能）

### 機能 1: LINE 連携を設定する

- LINE Developers Console で公式アカウントを作成、Channel Access Token と Channel Secret を取得
- `.env` に `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LINE_WEBHOOK_BASE_URL` / `LINE_CHANNEL_ID` を設定
- bookmee の「連携 / LINE」画面で接続状態が「接続済」になっているのを確認
- 画面に表示された webhook URL を LINE Console にコピペ登録
- 事務所側の初回設定はこれだけ

### 機能 2: スタッフが友だち追加 → 承認

- 新しいスタッフが LINE で公式アカウントを QR コードから友だち追加
- 自動で welcome reply: 「事務所スタッフ承認待ちです。所長が承認すると使えるようになります」
- bookmee の「連携 / LINE」画面に新しい行が出現（最初は **無効状態 `enabled=false`**）
- 所長がスタッフラベルを付けて **有効化トグルを ON**
- 以降そのスタッフからの画像が処理されるようになる
- 不審な第三者が友だち追加しても、有効化されない限り画像は受け付けない

### 機能 3: レシートを LINE で送る（メインユースケース）

- スタッフが業務中に紙の領収書を撮影
- LINE 公式アカウントのトーク画面で **画像を送る**
- 続けて **テキストで説明** を送る（例: 「青山デザイン 5/15 タクシー代」）
- 画像とテキストはどちらの順序でも OK（60 秒以内ならセットで扱われる）
- bookmee 側で自動的に:
  - 画像が Voucher として保存される（`source='line'`, `lineSourceMessageId`, `lineUserId`, `caption`）
  - OCR ジョブが走る（既存 spec 11）
  - 顧問先振り分け（既存 `voucher-assign-service`）
  - 突合（既存 spec 12）
  - 突合できなければドラフト仕訳生成（既存 spec 14）
- 「証憑登録」画面で開くと **LINE バッジ**付きで他の Voucher と並んで見える

### 機能 4: bookmee からスタッフに確認質問

OCR や仕訳の途中で bookmee が判断に迷ったら、Push API + Quick Reply で LINE に問い合わせ。

例:

> 「青山デザイン 5/15 タクシー代 ¥3,200 を **旅費交通費** で計上しました。よろしいですか？」
> [ ✅ OK ] [ 🔄 直す ] [ ❓ あとで ]

スタッフはタップするだけ。
- ✅ OK → `journalStatus='approved'`
- 🔄 直す → `journalStatus='rework'`
- ❓ あとで → `journalStatus='pending'`

質問タイミング:
- OCR 失敗 → 「読み取れませんでした、撮り直してください」
- 突合不一致でドラフト仕訳が生成された時 → 「この仕訳でよろしいですか？」
- 顧問先振り分けで複数候補がある時 → 「どの顧問先？: [青山デザイン] [橋本商店] [その他]」

### 機能 5: 間違いは bookmee の画面で修正

- LINE 経由で送った Voucher も既存「証憑登録」画面で見える・編集できる
- 顧問先振り分けが間違っていたら画面上の select で手動修正（既存機能）
- caption（LINE で送った説明テキスト）はサムネ近くに表示
- 削除も画面からできる

### 機能 6: 管理画面

「連携 / LINE」画面でできること:
- 接続状態の確認（env が設定済か、webhook URL）
- スタッフ一覧（誰が LINE 登録済か / 有効か / ラベル）
- 各スタッフの有効/無効切替、ラベル編集、削除

## アクター

- **税理士事務所スタッフ**: 自分の LINE で画像送信、bookmee からの質問にボタンで返答
- **所長 / 管理者**: 「連携 / LINE」画面でスタッフを承認する
- 顧問先からのアップロード受付は本 spec ではスコープ外（spec 17）

## データモデル

### 新規モデル

```prisma
model LineUserMapping {
  id          String   @id @default(cuid())
  lineUserId  String   @unique          // LINE userId (U で始まる)
  displayName String                    // 友だち追加時に LINE プロフィールから取得
  staffLabel  String?                   // bookmee 上のラベル ('所長' / 'スタッフ' 等)
  enabled     Boolean  @default(false)  // 所長が承認するまで false
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### 既存 Voucher への追加列

```prisma
source              String   @default("manual")  // 'manual' | 'line' | 'drive'
lineSourceMessageId String?  @unique             // LINE message.id（再送防止）
lineUserId          String?                      // 送信者の LINE userId
caption             String?                      // 画像と同送されたテキスト
```

注: `source` 列は spec 15（Drive）でも同じものを使う。先に実装される側で初出させる。

## 環境変数

`server/src/env.ts` の Zod スキーマに追加（全て `z.string().default('')`）:

```env
LINE_CHANNEL_ACCESS_TOKEN=     # 必須。Content API / Push API 用
LINE_CHANNEL_SECRET=           # 必須。webhook 署名検証用
LINE_WEBHOOK_BASE_URL=         # 本番のみ。例 https://bookmee.example.com
LINE_CHANNEL_ID=               # 任意。informational only
```

`LINE_CHANNEL_ACCESS_TOKEN` と `LINE_CHANNEL_SECRET` が両方セットされていれば「接続済」扱い。`LINE_WEBHOOK_BASE_URL` が未設定でも `/webhook` endpoint 自体は動く（開発時は ngrok 等のトンネルで対応）。

## API

| Method | Path | 用途 |
|---|---|---|
| `GET`   | `/api/integrations/line` | 接続状態（env 設定済か、webhook URL、登録 users 数、token 検証結果） |
| `POST`  | `/api/integrations/line/verify` | LINE API へ実トークン疎通確認（GET /v2/bot/info） |
| `POST`  | `/api/integrations/line/webhook` | LINE Messaging webhook 受け口（署名検証） |
| `GET`   | `/api/integrations/line/users` | LineUserMapping 一覧 |
| `PATCH` | `/api/integrations/line/users/:id` | `staffLabel` / `enabled` 更新 |
| `DELETE` | `/api/integrations/line/users/:id` | mapping 削除 |

### `GET /api/integrations/line`

レスポンス:
```json
{
  "connected": true,
  "channelId": "1234567890",
  "webhookUrl": "https://bookmee.example.com/api/integrations/line/webhook",
  "userCount": 3,
  "enabledUserCount": 2
}
```
`connected: false` のときは `channelId` / `webhookUrl` を返さない（ない場合がある）。

### `POST /api/integrations/line/verify`

接続テスト用。サーバ側で `GET https://api.line.me/v2/bot/info` を `Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN` で叩く。

レスポンス（成功）:
```json
{
  "ok": true,
  "botInfo": {
    "userId": "U...",
    "basicId": "@xxx",
    "displayName": "...",
    "chatMode": "bot",
    "markAsReadMode": "auto"
  }
}
```
失敗時: `{ ok: false, status: 401, message: '...' }`。

### `POST /api/integrations/line/webhook`

LINE Messaging webhook の受け口。

ヘッダ:
- `X-Line-Signature`: HMAC-SHA256(`Channel Secret`, body) の base64

検証手順:
1. body と signature を取り出す
2. `crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64')` で計算した値と比較
3. 不一致 → `401 INVALID_SIGNATURE` を返してそれ以上の処理は一切しない
4. 一致 → 200 を **即座に** 返し、event 処理は `setImmediate` で非同期に走らせる（LINE は webhook の応答を 30 秒以内に求める）

ボディの `events[]` を `line-importer.handleWebhookEvents` に渡す。

## webhook event 処理

`line-importer.handleWebhookEvents(events: LineEvent[]): Promise<void>`

各 event を順に処理（失敗時は logger.warn してループ継続）:

| event.type | message.type | 処理 |
|---|---|---|
| `follow` | — | `LineUserMapping` を `{ lineUserId, displayName }` で `enabled=false` で upsert（既存なら何もしない）。reply で welcome |
| `unfollow` | — | `LineUserMapping.enabled=false` に更新 |
| `message` | `image` | 後述「画像処理」 |
| `message` | `text` | caption キャッシュに保存 |
| `postback` | — | `data` をパースして `Voucher.journalStatus` を更新、reply で「更新しました」 |
| その他 | — | 200 OK で無視 |

### 画像処理

1. `LineUserMapping` を `lineUserId` で lookup
   - 未登録 → `displayName` を `getProfile()` で取って `enabled=false` で作成、reply「承認待ちです」、Voucher は作らない
   - `enabled=false` → reply「承認待ちです」、Voucher は作らない
2. 既存の `Voucher.lineSourceMessageId === message.id` を確認
   - あれば skip（冪等）
3. Content API `GET https://api-data.line.me/v2/bot/message/{messageId}/content` でバイナリ取得
   - 10MB 超 → skip して reply「サイズが大きすぎます」
   - mimetype が JPG/PNG 以外 → skip して reply「画像形式が非対応です」
4. caption キャッシュから取り出し（後述）
5. `createVoucher({ clientId: null, filename: 'line-${messageId}.jpg', mimeType, buffer, uploadedBy: 'line' })`
6. 作成された Voucher を `prisma.voucher.update` で `source='line'`, `lineSourceMessageId=message.id`, `lineUserId`, `caption` を後付け
7. `OPENAI_API_KEY` 設定済なら `runOcrForVoucher(meta.id)` を `setImmediate` でキック（既存 spec 11/12/14 のパイプライン）

### caption 一時キャッシュ

```ts
// line-importer.ts 内 module-level
const captionCache = new Map<string, { text: string; capturedAt: number }>();
const CAPTION_TTL_MS = 60_000;
```

- `text` event を受信 → `captionCache.set(lineUserId, { text, capturedAt: Date.now() })`
- `image` event を処理する直前: `const c = captionCache.get(lineUserId); captionCache.delete(lineUserId);` で取り出し、`Date.now() - c.capturedAt < CAPTION_TTL_MS` なら使う
- DB ではなく in-memory（プロセス再起動で消えるが許容）。マルチプロセス化したくなったら Redis に置き換える（YAGNI、今は Map で十分）
- 1 つの text が複数 image に紐付くのを避けるため、取り出したら即 delete

### 同一 batch 内の image + text 同時処理

LINE は 1 webhook batch に複数 event を載せる。同 user で image と text が同 batch にいる場合、order に関わらず caption が image に紐付くようにする:

1. events を user 毎に分けて、text を先に処理（キャッシュに入れる）→ image を後に処理（キャッシュから取り出す）の順で 1 batch を回す
2. user 跨ぎは独立

## Push & Reply の使い分け

| トリガ | API | 理由 |
|---|---|---|
| webhook 受信直後の即時応答 | Reply API（`replyToken`） | reply token は無料、1 webhook につき 1 回まで |
| 後段（OCR 完了 / 突合結果）の通知 | Push API | reply token は webhook 内のみ有効、OCR は非同期で完了するため |

### OCR / 仕訳完了後の Push（質問の発火点）

既存 `voucher-service.ts` の `assignAndMatchVoucher` 関数の末尾にフック点を追加（spec 11/12/14 の挙動を保ちつつ）。`Voucher.source==='line' && Voucher.lineUserId` のときに以下を判定して Push:

| 状況 | 送るメッセージ | Quick Reply |
|---|---|---|
| OCR 失敗 (`ocrStatus='failed'`) | 「画像の読み取りに失敗しました。撮り直してください。」 | なし |
| 顧問先振り分けで `clientId` が決まらず `matchedClientReason='ambiguous'` 等 | 「どの顧問先のレシートですか？」 | 候補上位 3 件のクライアント名（postback で `voucherId=xxx&action=client_xxx` を返す） |
| ドラフト仕訳が生成された (`journalStatus='drafted'`) | 「**\<勘定科目\>** \<金額\> で計上しました。よろしいですか？」 | ✅ OK / 🔄 直す / ❓ あとで |

Push の宛先 LINE userId は `Voucher.lineUserId`（送信者）にそのまま送り返す。

### postback の data 形式

```
voucherId=ckxxx&action=approve
voucherId=ckxxx&action=rework
voucherId=ckxxx&action=later
voucherId=ckxxx&action=client&clientId=aoyama-design
```

`action=approve|rework|later` は `Voucher.journalStatus` を `approved|rework|pending` に更新。
`action=client` は `Voucher.clientId` を更新後、`assignAndMatchVoucher` を再実行。

## 署名検証

```ts
import crypto from 'node:crypto';

export function verifySignature(channelSecret: string, rawBody: Buffer, signature: string): boolean {
  if (!channelSecret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', channelSecret)
    .update(rawBody)
    .digest('base64');
  // timing-safe 比較
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
```

webhook ルートでは Fastify の raw body を取り出す必要がある（`@fastify/raw-body` 不要、`request.rawBody` を有効にする設定を webhook ルートだけに当てる）。

## サーバ構成

**新規ファイル**:
- `server/src/routes/integrations-line.ts` — 上記 6 endpoints
- `server/src/services/line-service.ts` — LINE API ラッパ
  - `verifySignature(rawBody, signature): boolean`
  - `getBotInfo(): Promise<BotInfo>`（接続テスト用）
  - `getMessageContent(messageId): Promise<Buffer>`
  - `getProfile(userId): Promise<{ displayName, pictureUrl?, statusMessage? }>`
  - `replyMessage(replyToken, messages): Promise<void>`
  - `pushMessage(userId, messages): Promise<void>`
  - `pushQuickReply(userId, text, items): Promise<void>` — 上位ヘルパ
- `server/src/services/line-importer.ts` — `handleWebhookEvents(events)` + caption キャッシュ
- `server/src/services/line-mapping-service.ts` — LineUserMapping CRUD

**既存ファイル変更**:
- `server/src/server.ts` — `integrationsLineRoutes` を register
- `server/prisma/schema.prisma` — `LineUserMapping` + Voucher 拡張
- `server/src/env.ts` — LINE 系 4 つ追加
- `server/.env.example` — LINE 系 4 つ追記
- `server/src/services/voucher-service.ts` — `assignAndMatchVoucher` 末尾に「LINE 由来なら Quick Reply を Push」フックを追加（既存挙動は保つ）

**依存追加**: なし（`node:crypto` + `undici` で完結）

## フロントエンド構成

新規ビュー `data-view="integrations-line"`。左ナビに「連携 / LINE」を追加。

**2 ブロック構成**:

1. **接続状態パネル** (`.integration-line-connection`)
   - `GET /api/integrations/line` 結果を表示
   - access token / secret の有無、`channelId`、webhook URL（コピーボタン付き）
   - 「接続テスト」ボタン → `POST /api/integrations/line/verify`、結果を表示
   - LINE Developers Console 設定手順を 4 ステップで明示

2. **users mapping パネル** (`.line-user-mappings`)
   - `GET /api/integrations/line/users` の一覧
   - 各行: `displayName` / `staffLabel`（input 編集）/ `enabled`（toggle）/ 削除ボタン
   - 未登録ユーザは「友だち追加されると自動で行が追加されます（最初は無効状態）」と説明

**既存「証憑登録」ビューへの追加**:
- 各サムネに `Voucher.source` バッジを表示（既存 spec 15 計画と同じ実装。`'line'` のとき緑色バッジ）
- `caption` がある時はサムネ下部に小さく表示（例: "5/15 タクシー代"）

### appState 追加（`script.js`）

```js
lineIntegration: null,        // { connected, channelId, webhookUrl, userCount, enabledUserCount }
lineUsers: [],                // LineUserMapping[]
lineVerifyResult: null,       // 直近の verify 結果
```

## 失敗ハンドリング

| 状況 | 挙動 |
|---|---|
| `X-Line-Signature` ヘッダなし / 不一致 | 401 INVALID_SIGNATURE、それ以上の処理せず |
| `LINE_CHANNEL_ACCESS_TOKEN` 未設定で webhook 来た | 401 NOT_CONFIGURED |
| 既知の `messageId` で再送（LINE retry） | `lineSourceMessageId` unique で弾く → 200 で受理（冪等） |
| Content API 5xx / タイムアウト | 失敗 → 当該 event のみ skip、logger.warn。webhook 全体は 200 で返す |
| 未登録 LINE userId からのメッセージ | `LineUserMapping` を `enabled=false` で auto-create → reply「承認待ちです」、Voucher は作らない |
| Push API が「The user is blocked」を返す | logger.warn のみ、エラーで止まらない |
| Quick Reply postback の voucherId が見つからない | reply「対象が見つかりません」、200 OK |
| Reply API の replyToken expired（30 秒超過） | logger.warn のみ |

## テスト方針

既存方針（vitest + 実 Postgres、`vi.spyOn` で external API モック）を踏襲。LINE API は外部なので `line-service.ts` のラッパ関数を spy する。

### `tests/services/line-service.test.ts`（3 ケース、署名検証のみ）

1. 正しい signature → `verifySignature` が true
2. 不正な signature → false
3. body が空 → false

### `tests/services/line-importer.test.ts`（8 ケース）

1. `follow` event で LineUserMapping が `enabled=false` で auto-create される + welcome reply が呼ばれる
2. `unfollow` event で `enabled=false` になる
3. `message.image` from enabled user → Voucher が作成され、`source='line'` / `lineSourceMessageId` セット、OCR ジョブがキューされる
4. 既知の messageId → skip（冪等、Voucher 二重作成されない）
5. 未登録 user の image → LineUserMapping が auto-create、Voucher は作られず reply「承認待ち」
6. 同 batch の text → image 順 → caption が紐付く
7. 同 batch の image → text 順 → caption が紐付く（text が先に処理されてキャッシュに入るため）
8. `postback action=approve` で `Voucher.journalStatus='approved'` に更新

### `tests/routes/integrations-line.test.ts`（5 ケース）

1. `POST /webhook` で正しい signature → 200、`line-importer.handleWebhookEvents` が呼ばれる
2. `POST /webhook` で不正 signature → 401
3. `GET /api/integrations/line` で接続状態
4. `PATCH /users/:id` で staffLabel と enabled が更新される
5. `DELETE /users/:id` で行が消える

フロント側テストは基盤無しのため手動確認。

## 受入基準

- [ ] `npm run prisma:migrate` で `LineUserMapping` テーブルが作られ、`Voucher` に `source` / `lineSourceMessageId` / `lineUserId` / `caption` が追加される
- [ ] `.env` に LINE_* を設定して `npm run dev` 起動 → `/api/integrations/line` が `connected: true` を返す
- [ ] `POST /api/integrations/line/verify` で LINE API に疎通できる（`/v2/bot/info` が 200 を返す）
- [ ] LINE Developers Console の webhook URL に `/api/integrations/line/webhook` を設定（開発時は ngrok でトンネル）
- [ ] スタッフが LINE で友だち追加 → `LineUserMapping` が auto-create + welcome reply
- [ ] bookmee 「連携 / LINE」画面で `enabled=true` に変更
- [ ] LINE で画像を送る → Voucher が作られて OCR / 振り分け / 突合 / ドラフト仕訳が動く
- [ ] テキストと画像を続けて送ると `caption` にテキストが入る
- [ ] 同一 messageId の webhook 再送 → Voucher 二重作成されない
- [ ] 突合不一致のとき LINE に Push + Quick Reply（OK / 直す / あとで）が届く
- [ ] Quick Reply ボタンを押す → `Voucher.journalStatus` が更新される
- [ ] サーバテスト 16 ケース（line-service 3 + line-importer 8 + routes 5）が通る
- [ ] フロント「連携 / LINE」ビューで接続状態・users mapping が動く（手動確認）

## スコープ外（後続スペックで扱う）

- **顧問先（クライアント）向け LINE outreach**（spec 17）— spec 14 で「LINE は実体モック」と書かれていた部分のうち、顧問先向けを spec 17 で実装
- **LINE WORKS 関連コードの完全削除**（spec 17 と同タイミングで `notification.ts` の `sendLineWorksMessage` 等）
- **LIFF（ブラウザ in LINE）対応** — 本 spec はメッセージング API のみ
- **複数の LINE 公式アカウント運用** — env で 1 chan に固定
- **動画 / 音声 / ファイル messages** — image だけ対応
- **大量メッセージのフロー制御** — LINE Push の月間上限管理は本 spec ではしない
- **リッチメニュー / Flex Message** — テキスト + Quick Reply のみ

## 後続 spec への接続点

- spec 17（顧問先向け LINE）では、`LineUserMapping` とは別に `ClientLineUser`（顧問先紐付き）を追加し、Push 経路を outreach 側にも生やす
- spec 17 で `notification.ts` の LINE WORKS 実装を削除、`outreach-adapter.ts` の `LineOutreachAdapter` を公式 LINE で書き直す
- spec 03 / spec 09 の「LINE WORKS で顧問先連絡」記述は spec 17 で更新
