# 09. システムアーキテクチャ（本番化）

作成日: 2026-05-16

## 位置づけ
本スペックは 01〜08 の機能スペック群が前提とする**本番アーキテクチャ**を定義する。
- 静的プロトタイプは廃止し、フロント/バック分離構成へ移行
- マネーフォワード（MF）は実API連携、freee はモック維持
- 認証・権限は実装しない（本番運用前に別スペックで追加）
- メール / Slack / Chatwork / LINE WORKS の実送信は実装する
- OCR / 実AI推論は実装しない（既存の擬似スコアで継続）

## 全体構成

```
[Browser]
  index.html / styles.css / script.js (Vanilla)
        │
        │ fetch (JSON REST)
        ▼
[Backend: Node.js + TypeScript]
  Express or Fastify
   ├── Routes: /api/*
   ├── Services: client, sync, task, rule, message, receipt
   ├── Adapters:
   │     ├ MF API (OAuth2 + REST)
   │     ├ Email (SendGrid 推奨)
   │     ├ Slack (Bot Token)
   │     ├ Chatwork (API Token)
   │     └ LINE WORKS (Bot API)
   ├── Prisma ORM
   └── Background jobs (BullMQ + Redis or node-cron)
        │
        ▼
[PostgreSQL]
  正規データ + MFキャッシュ + 通知ログ + 履歴
```

## 技術スタック

| 層 | 採用 | 備考 |
|---|---|---|
| フロント | Vanilla HTML/CSS/JS（既存維持） | 既存 `index.html` `styles.css` `script.js` を再利用 |
| バック | Node.js 20+ / TypeScript 5+ | `tsx` で開発、`tsc` でビルド |
| HTTP | Fastify（推奨） or Express | Fastify 採用。型サポートとパフォーマンスで優位 |
| ORM | Prisma | スキーマ駆動、マイグレーション管理 |
| DB | PostgreSQL 16+ | JSONB 列で半構造化データも扱う |
| ジョブ | BullMQ + Redis（推奨） / node-cron 代替可 | MF同期、通知再送 |
| ログ | Pino（Fastify標準） | 構造化ログ |
| バリデーション | Zod | API入出力 |
| HTTP Client | undici (Node 標準) | MF API・通知API呼び出し |
| 設定 | `dotenv` + `process.env` | 環境変数中心 |

## ディレクトリ構成（推奨）

```
bookmee/
├── index.html               # 既存維持
├── styles.css               # 既存維持
├── script.js                # 既存維持。fetch呼び出しに書き換え
├── server/
│   ├── src/
│   │   ├── server.ts            # Fastify 起動
│   │   ├── routes/
│   │   │   ├── clients.ts
│   │   │   ├── tasks.ts
│   │   │   ├── rules.ts
│   │   │   ├── messages.ts
│   │   │   ├── receipts.ts
│   │   │   └── sync.ts
│   │   ├── services/
│   │   │   ├── client-service.ts
│   │   │   ├── sync-service.ts        # SWRキャッシュ戦略
│   │   │   ├── receipt-service.ts     # 不足検出
│   │   │   ├── rule-service.ts
│   │   │   ├── task-service.ts
│   │   │   └── message-service.ts
│   │   ├── adapters/
│   │   │   ├── mf-api.ts              # 実MF API連携
│   │   │   ├── freee-mock.ts          # モック
│   │   │   ├── email-sendgrid.ts
│   │   │   ├── slack.ts
│   │   │   ├── chatwork.ts
│   │   │   └── line-works.ts
│   │   ├── jobs/
│   │   │   ├── sync-mf.ts             # 定期/手動 MF同期
│   │   │   └── retry-notifications.ts
│   │   ├── lib/
│   │   │   ├── prisma.ts
│   │   │   └── logger.ts
│   │   └── env.ts
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── seed.ts                    # 既存 script.js のモックを移行
│   ├── package.json
│   └── tsconfig.json
└── docs/superpowers/specs/...
```

フロントとバックは同一リポジトリ。フロントは Fastify から静的配信（`fastify-static`）してもよいし、別ホスト配信でも可。

## データ取得戦略: Stale-While-Revalidate (SWR)

### 原則
1. リクエスト到着 → DBキャッシュから**即返却**
2. キャッシュ年齢が `STALE_THRESHOLD`（既定60分）超なら、レスポンス後にバックグラウンドで MF API を叩いて更新
3. キャッシュ年齢が `MAX_AGE`（既定6時間）超なら、同期を**待ってから**返す
4. 手動「いま取り込む」ボタンは強制同期

### 同期対象（MFのみ）
- 取引明細（仕訳）→ `Entry`
- 勘定科目マスタ → `Account`
- 証憑添付状態 → `Receipt`
- 残高試算表 → `BalanceSnapshot`
- 顧客企業マスタ → `Client.vendor='mf'` の社

### 同期ジョブ
- BullMQ ジョブ: `sync:client:{id}`
- 定期実行: 毎時0分に全`vendor='mf'`顧客
- イベント駆動: 顧客選択時、ステータス確認時に必要なら enqueue

### freee（モック）
- 同じインターフェース `VendorAdapter` を実装する `freee-mock.ts` で、固定モックデータを返す
- 将来 freee 実連携を追加するときは、このアダプタを実装で置き換えるだけ

## DB スキーマ概要（Prisma）

```prisma
model Client {
  id              String   @id @default(cuid())
  name            String
  industry        String
  vendor          String   // 'freee' | 'mf' | 'both'
  mode            String   @default("monthly") // 'monthly' | 'yearend'
  fiscalYearStart DateTime
  fiscalYearEnd   DateTime
  contactPrimary  String   // 'email' | 'slack' | 'chatwork' | 'line_works' | 'messenger'
  contactEndpoints Json    // { email: '...', slack: '...', ... }
  receiptPolicyOverrides Json?

  // MF OAuth トークン（暗号化は将来課題）
  mfAccessToken     String?
  mfRefreshToken    String?
  mfTokenExpiresAt  DateTime?
  mfExternalId      String?       // MF側の事業者ID

  vendorSyncs     VendorSync[]
  entries         Entry[]
  receipts        Receipt[]
  matchings       Matching[]
  tasks           Task[]
  rules           Rule[]
  threads         Thread[]
  yearendChecklist YearendCheck[]
  yearendKpi      Json?

  updatedAt       DateTime @updatedAt
  createdAt       DateTime @default(now())
}

model VendorSync {
  id        String   @id @default(cuid())
  client    Client   @relation(fields: [clientId], references: [id])
  clientId  String
  vendor    String   // 'freee' | 'mf'
  lastSync  DateTime?
  status    String   // 'ok' | 'warn' | 'error'
  count     Int      @default(0)
  errorMsg  String?
  @@unique([clientId, vendor])
}

model Entry {
  id            String   @id @default(cuid())
  client        Client   @relation(fields: [clientId], references: [id])
  clientId      String
  source        String   // 'mf' | 'freee'
  sourceEntryId String?  // MF側のID（同期キー）
  account       String
  description   String
  amount        Int
  taxClass      String?
  occurredAt    DateTime
  receiptStatus String   @default("na") // 'matched' | 'missing' | 'partial' | 'na'
  score         Int?     // 既存の擬似AIスコア相当（priority算出に使用）
  requestedAt   DateTime? // 07: 不足→依頼送信完了で立てる
  raw           Json?    // 元データ全文（デバッグ・将来拡張）
  syncedAt      DateTime @default(now())
  @@index([clientId, occurredAt])
  @@unique([source, sourceEntryId])
}

model Receipt {
  id            String   @id @default(cuid())
  client        Client   @relation(fields: [clientId], references: [id])
  clientId      String
  source        String
  sourceReceiptId String?
  status        String   // 'attached' | 'missing' | 'candidate'
  vendorRef     String?  // 取引先・適用
  amount        Int?
  occurredAt    DateTime
  raw           Json?
  syncedAt      DateTime @default(now())
}

model Matching {
  id            String   @id @default(cuid())
  client        Client   @relation(fields: [clientId], references: [id])
  clientId      String
  source        String
  invoiceRef    String
  invoiceAmount Int
  paidAmount    Int
  diffNote      String?
  status        String   // 'matched' | 'open' | 'urgent' | 'done'
  occurredAt    DateTime
  raw           Json?
  syncedAt      DateTime @default(now())
}

model Task {
  id        String   @id @default(cuid())
  client    Client   @relation(fields: [clientId], references: [id])
  clientId  String
  title     String
  note      String
  category  String   // 'AI仕訳候補' | '証憑' | '消込' | '月次チェック' 等
  status    String   // 'urgent' | 'open' | 'done'
  score     Int
  stage     String   // 'staff_doing' | 'awaiting_approval' | 'approved' | 'rejected'
  assignee  String?
  approver  String?
  history   TaskHistory[]
  ruleId    String?  // ヒットしたルール
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}

model TaskHistory {
  id      String   @id @default(cuid())
  task    Task     @relation(fields: [taskId], references: [id])
  taskId  String
  at      DateTime @default(now())
  by      String
  action  String   // 'staff_complete' | 'approve' | 'reject' | 'resubmit' | 'comment'
  comment String?
}

model Rule {
  id         String   @id @default(cuid())
  client     Client   @relation(fields: [clientId], references: [id])
  clientId   String
  type       String   // 'template' | 'custom'
  industry   String?
  title      String
  detail     String
  severity   String   // 'high' | 'mid' | 'low'
  active     Boolean  @default(true)
  createdBy  String
  createdAt  DateTime @default(now())
  hits       RuleHit[]
}

model RuleHit {
  id       String   @id @default(cuid())
  rule     Rule     @relation(fields: [ruleId], references: [id])
  ruleId   String
  at       DateTime @default(now())
  target   String
  outcome  String   // 'matched' | 'overridden' | 'rejected'
}

model Thread {
  id        String   @id @default(cuid())
  client    Client   @relation(fields: [clientId], references: [id])
  clientId  String
  channel   String   // 'email' | 'slack' | 'chatwork' | 'line_works' | 'messenger'
  direction String   // 'in' | 'out'
  subject   String?
  body      String
  preview   String?
  status    String   @default("queued") // 'queued' | 'sent' | 'failed' | 'received'
  externalId String? // 送信先サービスのID
  errorMsg  String?
  scheduledAt DateTime?
  sentAt    DateTime?
  createdAt DateTime @default(now())
}

model ReceiptPolicy {
  account            String  @id  // 科目名がキー
  requiresReceipt    Boolean @default(true)
  requiresApproval   Boolean @default(false)
  exemptUnder        Int?
  notes              String?
}

model YearendCheck {
  id        String  @id @default(cuid())
  client    Client  @relation(fields: [clientId], references: [id])
  clientId  String
  title     String
  note      String?
  status    String  // 'open' | 'urgent' | 'done'
  order     Int
}
```

## REST API 概要

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/clients` | 顧問先一覧 |
| GET | `/api/clients/:id` | 詳細（SWRで返す） |
| POST | `/api/clients/:id/sync` | 強制同期キック |
| GET | `/api/clients/:id/entries` | 仕訳一覧 |
| GET | `/api/clients/:id/missing-receipts` | 不足証憑（派生計算） |
| GET | `/api/clients/:id/tasks` | タスク一覧（stage/role フィルタ可） |
| POST | `/api/tasks/:id/transition` | stage 遷移（approve/reject/staff_complete/resubmit） |
| GET | `/api/clients/:id/rules` | ルール一覧 |
| POST | `/api/clients/:id/rules` | ルール追加 |
| PATCH | `/api/rules/:id` | 編集・active切替 |
| DELETE | `/api/rules/:id` | 削除 |
| GET | `/api/clients/:id/threads` | 連絡履歴 |
| POST | `/api/messages` | メッセージ作成（送信予約 or 即時） |
| POST | `/api/messages/:id/send` | 送信実行 |
| GET | `/api/receipt-policies` | 証憑要件一覧 |
| PATCH | `/api/receipt-policies/:account` | 編集 |
| GET | `/api/sync-status` | 全顧客の同期ステータス（サイドバー用） |
| GET | `/api/summary` | サマリーKPI（mode別） |

レスポンス形式は JSON。エラーは `{ error: { code, message } }`。

## MF API 連携詳細

### OAuth 設定
- 環境変数: `MF_CLIENT_ID`, `MF_CLIENT_SECRET`, `MF_REDIRECT_URI`
- 初期接続フロー: 管理者が `GET /api/mf/oauth/start` で認可URLへ → コールバック `/api/mf/oauth/callback` で `access_token` + `refresh_token` を取得し DB の `Client.vendorAuthMf`（追加列）に格納
- token refresh: 期限切れ前にバックグラウンドで refresh
- 認証なし方針なので、初期セットアップは CLI スクリプト or 手動でも可

### 取得API
MFクラウド会計の標準APIを使用（具体エンドポイントは実装時にMF公式ドキュメント参照）:
- 取引一覧
- 勘定科目
- 取引添付（証憑）
- 試算表

### 同期処理
- 1顧客 1ジョブ（並列実行可）
- 重複同期は queue 側でデバウンス
- 失敗時は exponential backoff で再試行（最大5回）
- ジョブ結果を `VendorSync` に記録

### レート制限
- MF API のレート制限を尊重（Retry-After ヘッダ対応）
- 全社一斉同期はずらして実行

## 通知（実送信）

### Email（SendGrid 推奨）
- 環境変数: `SENDGRID_API_KEY`, `EMAIL_FROM`
- 送信API: `POST /v3/mail/send`
- 失敗時は `Thread.status = 'failed'` + `errorMsg` 保存、自動再試行ジョブ

### Slack
- 環境変数: `SLACK_BOT_TOKEN`
- 送信API: `chat.postMessage`
- 顧客ごとに Slack Channel ID を `Client.contactEndpoints.slack` に保存
- 接続不可・チャンネル未存在は `failed`

### Chatwork
- 環境変数: `CHATWORK_API_TOKEN`（管理者個人トークン）
- 送信API: `POST /v2/rooms/{room_id}/messages`
- room_id を `contactEndpoints.chatwork` に保存
- `[To:userid]` プレフィックス対応

### LINE WORKS
- 環境変数: `LINEWORKS_BOT_ID`, `LINEWORKS_CLIENT_ID`, `LINEWORKS_CLIENT_SECRET`, `LINEWORKS_SERVICE_ACCOUNT`, `LINEWORKS_PRIVATE_KEY`
- JWT署名 → access_token 発行 → Bot メッセージ送信
- channelId を `contactEndpoints.line_works` に保存

### 共通仕様
- 送信は `POST /api/messages` または `POST /api/messages/:id/send` 経由
- 即時送信モードでも DB に `Thread` レコード作成 → 送信 → status 更新の3ステップ
- Bull job で再試行（30秒, 5分, 30分, 2時間, 24時間）

## 環境変数一覧

```
# DB
DATABASE_URL=postgresql://...

# サーバー
PORT=3000
NODE_ENV=development

# Redis（Bull）
REDIS_URL=redis://...

# MF API
MF_CLIENT_ID=...
MF_CLIENT_SECRET=...
MF_REDIRECT_URI=http://localhost:3000/api/mf/oauth/callback
MF_BASE_URL=https://invoice.moneyforward.com  # 実際のエンドポイントは実装時確認

# 通知
SENDGRID_API_KEY=...
EMAIL_FROM=bookmee@example.com

SLACK_BOT_TOKEN=xoxb-...

CHATWORK_API_TOKEN=...

LINEWORKS_BOT_ID=...
LINEWORKS_CLIENT_ID=...
LINEWORKS_CLIENT_SECRET=...
LINEWORKS_SERVICE_ACCOUNT=...
LINEWORKS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."

# キャッシュ閾値
STALE_THRESHOLD_SEC=3600
MAX_AGE_SEC=21600
```

## デプロイ（参考）
- 開発: `npm run dev`（tsx watch）+ Docker Compose で PG/Redis 起動
- 本番（推奨）: Railway / Fly.io / Render に server デプロイ、PostgreSQL マネージド、Redis マネージド
- フロント: 同サーバーから静的配信、または Vercel/Cloudflare Pages
- ※ 本番デプロイの詳細選択は別スペック範囲

## script.js の改修方針

既存の `clients[]` 直参照を以下に置換:

```js
// Before
const clients = [...固定モック...];
function currentClient() { return clients[appState.activeClient]; }

// After
let clients = [];
async function loadClients() {
  const res = await fetch('/api/clients');
  clients = await res.json();
  render();
}
async function syncClient(id) {
  await fetch(`/api/clients/${id}/sync`, { method: 'POST' });
  await loadClients();
}
```

具体置換:
- `currentClient()`: `clients[appState.activeClient]` → API取得後のキャッシュ参照
- 承認/差戻し: `POST /api/tasks/:id/transition`
- ルール追加/削除: `POST/DELETE /api/clients/:id/rules`
- 送信予約: `POST /api/messages`
- 同期: `POST /api/clients/:id/sync`

エラー時のトースト表示・楽観的UI更新は実装時に検討。最小実装は「fetch → 全 reload」でも可。

## スコープ外
- 認証・権限・マルチテナント
- freee 実API連携
- OCR / 実AI推論
- 監査ログ・データエクスポート
- 多リージョン・高可用性構成

## 受入基準
- [ ] フロントが `script.js` から `fetch('/api/...')` を呼び、本物のDBデータが描画される
- [ ] MF API への OAuth 認可完了 → 顧客の取引・証憑・試算表が DB に取り込まれる
- [ ] freee 顧客は `freee-mock.ts` の固定データが返る
- [ ] サイドバー連携カードが MF と freee の同期状態（緑/橙/赤）を表示する
- [ ] メール / Slack / Chatwork / LINE WORKS のいずれかで実メッセージが送信できる
- [ ] 送信失敗時に再試行され、`Thread.status` が更新される
- [ ] STALE_THRESHOLD 超のキャッシュは、レスポンス後にバックグラウンド更新される
- [ ] MAX_AGE 超なら同期を待ってから返す
- [ ] `npm run dev` でローカル起動、`prisma migrate dev` でDB初期化、`npm run seed` でモック投入できる
