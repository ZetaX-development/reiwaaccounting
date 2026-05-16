# 03. 顧問先連絡チャンネル一元化

改善案: ③ 顧問先連絡チャンネルの一元化

## 背景
- 牧野氏: 「Slack・メッセンジャー・メール・LINE WORKS……すごいやり取りがめんどくさい」
- 足立氏: 「顧問先によって連絡手段が違う。セキュリティポリシーや好みで」
- 顧問先ごとに「ここはChatwork、ここはメール」とバラバラ。zeimee で全チャンネルを束ね、依頼文自動生成と組み合わせる。

## ゴール
1. 顧問先ごとの「優先連絡チャンネル」が画面に明示される
2. 1つの依頼文を、顧問先ごとに正しいチャンネルへ送信予約**または即時送信**できる
3. 過去のやり取り履歴がチャンネル横断で zeimee 内に時系列で見える
4. 同じ依頼文をチャンネルごとに自動でフォーマット調整（メール = 件名+本文、Slack = 短文+箇条書き等）
5. **Email / Slack / Chatwork / LINE WORKS の実送信**が動作する。受信は対象外

## 本番アーキ前提
- 09 の通知アダプタ4本を実装:
  - `server/src/adapters/email-sendgrid.ts`
  - `server/src/adapters/slack.ts`
  - `server/src/adapters/chatwork.ts`
  - `server/src/adapters/line-works.ts`
- 共通インターフェース:
  ```ts
  interface ChannelAdapter {
    send(endpoint: string, payload: { subject?: string; body: string; raw?: any }): Promise<{ externalId?: string }>;
  }
  ```
- 失敗時は BullMQ 再試行（30s, 5m, 30m, 2h, 24h）
- 全送信は `Thread` レコードに `status` で追跡（queued → sent | failed）

## DBモデル（09 の Prisma スキーマで定義済み）
- `Client.contactPrimary`, `Client.contactEndpoints` (JSON)
- `Thread`（channel, direction, subject, body, status, externalId, errorMsg, scheduledAt, sentAt, ...）

`endpoints` の例:
```json
{ "email": "aoyama@example.com",
  "slack": "C0123456789",      // Slack Channel ID
  "chatwork": "12345",          // Chatwork Room ID
  "line_works": "channel-uuid", // LINE WORKS channel ID
  "messenger": null }
```

## API

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/clients/:id/threads` | 履歴取得（時系列降順） |
| POST | `/api/messages` | メッセージ作成（送信予約 or 即時） |
| POST | `/api/messages/:id/send` | 送信実行（手動） |
| PATCH | `/api/clients/:id/contact` | 優先チャンネル/endpoints 編集 |

`POST /api/messages` の body:
```json
{ "clientId": "...",
  "channel": "email",
  "subject": "...",       // email のみ
  "body": "...",
  "scheduledAt": null,    // null=即時、ISO=予約
  "originRef": null       // 07 で生成した依頼の ID 等（任意） }
```

## 機能要件

### F1. チャンネルバッジ
`renderClients()` の顧問先ストリップ、社名行に `contact.primary` を pill で表示:
- email / slack / chatwork / line_works / messenger それぞれの色
- ラベル: `labels.channel.*`（06 と整合）

### F2. 連絡ハブ（顧問先連絡ビュー再設計）
`renderPortal()` を3カラム再構成:

**左: チャンネル選択+依頼文編集**
- 上部にチャンネル切替タブ（`contact.primary` 既定、フォールバックも選択可）
- 中央に依頼文 textarea（`#portalDraft`）
- フォーマット差し替えボタン「メール用」「Slack用」「Chatwork用」「LINE WORKS用」
  - 押下でクライアント側 `formatForChannel()` を実行（純関数）

**中央: 過去のやり取り（time-line）**
- `GET /api/clients/:id/threads` の結果を時系列リスト
- in/out アイコン、チャンネル pill、preview、status バッジ（送信済/予約/失敗）

**右: 連絡先設定**
- `endpoints` を `setting-row` 形式で編集（input）
- 「優先チャンネルを変更」セレクタ
- 保存ボタン → `PATCH /api/clients/:id/contact`

### F3. 送信予約／即時送信
左カラム下部にボタン2つ:
- 「いま送る」 → `POST /api/messages`（scheduledAt: null）→ サーバが同期送信
- 「予約送信」 → 日時選択 → `POST /api/messages`（scheduledAt: ISO）→ Bull job でスケジュール

サーバー処理:
1. `Thread` を `status: 'queued'` で作成
2. 即時/到来時に対応 adapter の `send()` 実行
3. 成功 → `status: 'sent'`, `sentAt`, `externalId` 保存
4. 失敗 → `status: 'failed'`, `errorMsg` 保存、再試行ジョブ enqueue

### F4. AIパネルとの連携
右AIパネル `#messageDraft` の下に「このチャンネル向けに最適化」ボタン追加。
押下で現在の連絡ビューのチャンネルに合わせて整形 → `#portalDraft` に流し込み。

### F5. クロス顧問先のチャンネル別件数
`#runAiButton` の右に小ラベル: 「未送信: メール◯ / Slack◯ / Chatwork◯ / LW◯」
`GET /api/summary` の `pendingByChannel` を参照。

### F6. 失敗履歴の確認と手動再送
履歴リストの `status: 'failed'` 行に「再送」ボタン → `POST /api/messages/:id/send`

## index.html 変更
- `topbar-actions` に `<small id="pendingByChannel"></small>` を追加
- AIパネル `messageDraft` の下のボタン行に `<button class="ghost-action" id="optimizeForChannel">チャンネル最適化</button>`

## script.js 変更

| 関数 | 変更 |
|---|---|
| `loadThreads(clientId)` 新設 | `GET /api/clients/:id/threads` |
| `sendMessage(payload)` 新設 | `POST /api/messages` |
| `resendMessage(id)` 新設 | `POST /api/messages/:id/send` |
| `updateContact(clientId, body)` 新設 | `PATCH /api/clients/:id/contact` |
| `renderClients` | チャンネルバッジ |
| `renderPortal` | 3カラム + 履歴 + 設定 |
| `renderSummary` | 未送信件数の集計表示 |
| 新規 `formatForChannel(text, channel)` | クライアント側純関数 |
| 新規 `renderChannelTimeline(threads)` | 履歴リストを返す |

### `formatForChannel` の整形ルール（クライアント側）
- email: 件名行 + 改行 + 本文
- slack: 「@channel」プレフィックス + 箇条書き化 + 末尾簡略化
- chatwork: 「[To:userid]」プレフィックス + 改行多め
- line_works: 短文化（1段落）
- messenger: 短文 + emoji 1つ

## サーバ側実装詳細

### Email（SendGrid）
- env: `SENDGRID_API_KEY`, `EMAIL_FROM`
- ライブラリ: `@sendgrid/mail`
- payload: `{ to, from, subject, text }`
- 失敗判定: SendGrid レスポンス 4xx/5xx
- to は `endpoints.email`（カンマ区切りで複数可）

### Slack
- env: `SLACK_BOT_TOKEN`
- ライブラリ: `@slack/web-api` の `client.chat.postMessage`
- channel = `endpoints.slack`（C で始まる Channel ID）
- bot がチャンネルに入っていない場合は `not_in_channel` エラーを `errorMsg` に保存

### Chatwork
- env: `CHATWORK_API_TOKEN`
- HTTP: `POST https://api.chatwork.com/v2/rooms/{room_id}/messages`
- header: `X-ChatWorkToken: {token}`
- body: `body=...`（form-encoded）
- room_id = `endpoints.chatwork`

### LINE WORKS
- env: `LINEWORKS_BOT_ID`, `LINEWORKS_CLIENT_ID`, `LINEWORKS_CLIENT_SECRET`, `LINEWORKS_SERVICE_ACCOUNT`, `LINEWORKS_PRIVATE_KEY`
- 認証: JWT 署名 → `https://auth.worksmobile.com/oauth2/v2.0/token` で access_token 取得（適宜キャッシュ）
- 送信: `POST https://www.worksapis.com/v1.0/bots/{botId}/channels/{channelId}/messages`
- channelId = `endpoints.line_works`

### 共通: 再試行ジョブ
- BullMQ: queue `notification-retry`
- 失敗時に `attempts` をインクリメントしながら 30s, 5m, 30m, 2h, 24h で再試行
- 5回失敗で `status: 'failed'` 確定（`errorMsg` 詳細保持）

## styles.css 追加
- 各チャンネル色の `.pill.email / .slack / .chatwork / .line_works / .messenger`
- `.portal-3col { display: grid; grid-template-columns: 1.2fr 1fr 0.8fr; gap: 16px }`
- `.thread-item { display:flex; gap:8px; padding:10px; border-bottom:1px solid #eee }`
- `.thread-item.in { background:#fafafa } / .out { background:#fff }`
- `.thread-status.queued / .sent / .failed` のバッジ

## 07（証憑不足）との連携点
- 07 が生成した依頼文を `POST /api/messages` の body にそのまま渡す
- `originRef` に missingReceiptIds を入れて、送信完了時に該当不足項目を「依頼済み」マーク（07側責務）

## 06（UIシンプル化）との連携点
- ボタン文言は `labels.channel.*` 経由
- ステータス表現も「送信済／待ち中／うまく届かなかった」等の自然文

## 08（重複回避）との連携点
- 受信メッセージの取り込みはしない（既存メーラー / 各ツールで読む）
- zeimee は「送信」と「送信履歴の記録」だけを担う

## スコープ外
- 受信メッセージの取り込み（IMAP, Slack Events, Chatwork Webhook 等）
- ファイル添付対応
- メールスレッド継続（In-Reply-To 等）
- 各サービスへの認可UI（管理者がENV設定で完結）
- 個人別のSlackメンション最適化

## 受入基準
- [ ] 各顧問先カードに優先チャンネル pill が表示される
- [ ] 顧問先連絡ビューが3カラム（編集 / 履歴 / 設定）になる
- [ ] チャンネル切替タブで文面整形が切り替わる
- [ ] 「いま送る」を押すと該当チャンネルへ実送信される（4チャンネル全て）
- [ ] 送信成功で `Thread.status='sent'` になり、`externalId` が記録される
- [ ] 送信失敗で `Thread.status='failed'`、`errorMsg` が記録され、再試行ジョブが走る
- [ ] 「予約送信」で `scheduledAt` 到来時に自動送信される
- [ ] 履歴リストに送信済/予約/失敗が時系列で出る
- [ ] AIパネルの「チャンネル最適化」で現チャンネル形式に整形される
- [ ] ヘッダー右に「未送信: メール◯ / Slack◯ / Chatwork◯ / LW◯」が出る
