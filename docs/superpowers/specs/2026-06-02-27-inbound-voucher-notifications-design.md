# spec 27: 証憑インバウンド通知（LINE / Drive 追加のポップアップ）

作成日: 2026-06-02

## 目的

LINE / Google Drive から証憑が自動投入されたとき、Web アプリ（経理丸ごとAI）の利用者に
「どこから何件追加されたか」をポップアップ（トースト）で知らせる。スタッフが投入に気づかず
放置するのを防ぐ。

ユーザ要望:
1. **リアルタイム**: アプリを開いている人に、新着証憑が来たら即座にポップアップを出す
2. **新規ログイン・再訪時**: 久しぶりに開いた人にも、前回以降に増えた分を
   「〜件追加しました」と集約表示する

## 対象範囲

- 通知対象の投入元: **`source = 'line'` と `source = 'drive'` の Voucher のみ**。
  `manual`（手動アップロード）は通知しない。
- **メール受信からの証憑取り込みは対象外**。現状コードにメール→証憑のインバウンド経路は
  存在せず、新規実装は本スペックのスコープ外（別プロジェクト）。
- 検知の基準時刻は **`Voucher.createdAt`**（＝証憑が投入された瞬間）。OCR や仕訳ドラフトの
  完成は待たない。

## 非ゴール

- メール受信→証憑化の仕組み
- 証憑1件ごとの詳細表示（差出人・画像プレビュー等）
- SSE / WebSocket による真のサーバプッシュ（ポーリングで代替）
- サーバ側での「既読」状態の永続化（クライアントの localStorage で管理）
- サイドバー赤バッジ
- トーストクリックでの画面遷移（余裕があれば後日。まずは表示を優先）

## データモデル

スキーマ変更なし。既存の `Voucher` の以下の列のみ使用:
- `firmId` — テナント絞り込み
- `source` — `'line' | 'drive' | 'manual'`
- `createdAt` — 投入時刻

## API

### `GET /api/vouchers/inbound-since?since=<ISO8601>`

- 認証: `requireAuth` 配下。`firmId` は `req.user.firmId` から取得。
- クエリパラメータ `since`: ISO8601 文字列（任意）。未指定または不正な場合は
  「全件が新着扱い」ではなく **サーバ now を返すだけで total=0** とする
  （初回アクセス時に過去分が大量通知されるのを防ぐ）。
- 集計対象: `firmId` 一致 かつ `source IN ('line','drive')` かつ `createdAt > since`。
- レスポンス:
  ```json
  {
    "now": "2026-06-02T12:34:56.000Z",
    "total": 3,
    "counts": { "line": 2, "drive": 1 }
  }
  ```
  - `now`: サーバの現在時刻（クライアントはこれを次回の `since` として保存。クロックずれ回避）
  - `total`: line + drive の合計
  - `counts`: ソース別件数（0 のソースも含めてよい）
- `server.ts` の `buildApp()` にルート登録する（自動ロードしない方針に従う）。

## フロントエンド（script.js）

### 状態

- `localStorage['bookmee.lastInboundSeenAt']`: 最後に確認したサーバ時刻（ISO8601）。
- `appState.inboundPollTimer`: 全画面共通ポーラーの timer id。

### 初期化時（セッション確立後、`loadClientsFromApi` などと同じ起動シーケンス内）

1. `since = localStorage['bookmee.lastInboundSeenAt']`（無ければ未指定）で
   `GET /api/vouchers/inbound-since` を呼ぶ。
2. 保存値が無かった場合（初回）: 通知は出さず、`now` を保存して終了。
3. 保存値があった場合: `total > 0` なら集約メッセージをトースト表示し、`now` を保存。

### 全画面共通ポーラー（view 非依存）

- `setInterval` 15 秒。既存の証憑登録画面の 5 秒ポーリングとは独立。
- `document.hidden` が true の間はスキップ（タブ非表示中は通知を溜めない）。
- 毎回 `since = 保存値` で叩き、`total > 0` ならトースト表示、`now` を保存。
- エラー時は握りつぶす（`console.warn` のみ、アプリ本体を壊さない）。
- 多重起動防止: 既存 timer があれば張り直さない。

### メッセージ生成

`counts` から動的生成。0 件のソースは省略。
- 例: line=2, drive=1 → `「LINEから2件、Google Driveから1件の証憑が追加されました」`
- 例: line=0, drive=1 → `「Google Driveから1件の証憑が追加されました」`
- `showToast(message, 'info')` を使用。

## エラーハンドリング

- API エラー / ネットワーク失敗: トーストを出さず `console.warn`。次回ポーリングで回復。
- `since` が壊れた値: サーバ側で無視して `now` のみ返す（total=0）。
- 認証切れ（401/403）: 通常の API と同様。通知ポーラーは黙って失敗し、アプリを壊さない。

## テスト方針

### バックエンド（vitest・実 Postgres、モックなし）

`tests/routes/vouchers-inbound-since.test.ts`（または既存 vouchers テストに追記）:
- seed クライアント配下に `source` と `createdAt` の異なる Voucher を複数作成
  （line 過去 / line 直近 / drive 直近 / manual 直近）。
- `since` を中間時刻にして叩き、`counts.line` / `counts.drive` が
  「since より後の line/drive のみ」を数えること、`manual` が除外されること、
  他 firm の Voucher が混ざらないことを検証。
- `since` 未指定なら total=0 で `now` が返ること。

### フロントエンド

- `node --check script.js` の構文チェック。
- 手動 UI 確認: LINE/Drive 経由で証憑を投入 → 15 秒以内にトースト。
  別タブで開き直して前回以降の追加分が集約表示されること。

## 受入基準

1. LINE から証憑を送ると、アプリを開いている画面に 15 秒以内で
   「LINEから◯件の証憑が追加されました」トーストが出る。
2. Drive 取り込みでも同様に「Google Driveから◯件…」が出る。
3. アプリを開き直すと、前回確認以降に増えた LINE/Drive 分が集約トーストで出る。
   増分が無ければ何も出ない。初回アクセスでは過去分の通知が出ない。
4. 手動アップロード（manual）では通知が出ない。
5. 別事務所（firm）の証憑は通知に混ざらない。
6. 通知 API が失敗してもアプリの他機能は壊れない。
