# spec 31: 証憑追加の通知センター（右上ベル）

作成日: 2026-06-02

## 目的

LINE / Google Drive から証憑が追加されたとき、Web アプリ右上のベルアイコンに通知を溜め、
あとから一覧で確認できるようにする。spec 27 の「追加されました」トースト（ポップアップ）は
そのまま残し、本機能はその通知を蓄積・履歴化する追加機能。

ユーザ要望:
- 右上に通知マークを付けて、LINE/メール由来の証憑追加通知をそこに溜め込みたい。
- 1件ずつ詳細（何が・どこに・いつ）が見えること。
- 通知をクリックしたら該当証憑（突合結果）へジャンプしたい。
- 既存のトーストはそのまま。

## 決定事項

- **通知の中身は1件ずつ詳細**（source / 勘定科目 / 金額 / 顧問先名 / 時刻）。
- **クリックで該当証憑の突合結果へジャンプ**（顧問先タブを開いて該当証憑をハイライト）。
- **サーバーから取得**して一覧化（リロード後・アプリを閉じていた間の分も残る）。
- **既読は「クリア」ボタンで行う**：ベルを開いただけでは既読にならない。パネル内の「クリア」
  ボタンを押すと全件既読になり未読バッジが 0 になる（個別既読は作らない）。
- ベルの位置は右上 `topbar-actions` の左端。
- 既存トースト（spec 27）は変更しない。

## 対象範囲

- 通知対象: `source IN ('line','drive')` の Voucher（manual 除外）。
- firm スコープ（`req.user.firmId`）。

## 非ゴール

- サーバー側での既読状態の永続化（クライアントの localStorage で管理）。
- 証憑以外（エラー・システム等）の通知。
- 真のサーバープッシュ（spec 27 の 15 秒ポーリングに相乗り）。
- 通知の削除・アーカイブ機能。

## データモデル

スキーマ変更なし。既存 `Voucher`（`firmId` / `source` / `uploadedAt` / `ocrJson` /
`draftJournalJson` / `clientId` / `journalStatus`）と `Client.name` を使用。

## API

### `GET /api/vouchers/inbound-recent?limit=20`

- 認証: `requireAuth` 配下。`firmId` は `req.user.firmId`。
- `limit`: 任意。既定 20、上限 50（範囲外は丸める）。
- 集計対象: `firmId` 一致 かつ `source IN ('line','drive')`、`uploadedAt` の新しい順。
- レスポンス（配列）:
  ```json
  [
    {
      "id": "cmpvz750q...",
      "source": "line",
      "uploadedAt": "2026-06-02T01:45:39.626Z",
      "vendor": "MOS BURGER 渋谷道玄坂店",
      "amount": 940,
      "account": "会議費",
      "clientId": "shibuya-cafe",
      "clientName": "渋谷カフェ",
      "journalStatus": "approved"
    }
  ]
  ```
  - `vendor`: `ocrJson.vendor_name`（無ければ null）
  - `amount`: `ocrJson.amount`（数値でなければ `draftJournalJson.debit.amount`、それも無ければ null）
  - `account`: `draftJournalJson.debit.account`（無ければ null）
  - `clientName`: `clientId` から Client.name を引く（未割当なら null）
- `voucherRoutes` に追加（既に server.ts で登録済みなので登録変更は不要）。
- 集計は service 関数 `listInboundRecent(firmId, limit)` に置く。

## フロントエンド（script.js / index.html）

### 配置・マークアップ

- `index.html` の `topbar-actions` 左端にベルボタンを追加:
  ```html
  <button class="notif-bell" id="notifBell" aria-label="通知">
    🔔<span class="notif-badge" id="notifBadge" hidden></span>
  </button>
  <div class="notif-panel" id="notifPanel" hidden></div>
  ```
- バッジ・パネルの最小スタイルを `styles.css` に追加（既存トークンに合わせる）。

### 状態

- `appState.notifications`: `inbound-recent` の取得結果（配列）。
- `localStorage['bookmee.notifSeenAt']`: 最後に「クリア」した時刻（ISO）。無ければ未読判定の
  基準は「全件未読扱いしない」＝初回は now を保存してバッジ 0 から始める（過去分を未読にしない）。

### 未読数とポーリング

- 未読数 = `notifications` のうち `uploadedAt > notifSeenAt` の件数。0 なら `notifBadge` を隠す。
- spec 27 の 15 秒ポーラー（`checkInboundVouchers`）の中で `refreshNotifications()` も呼び、
  `inbound-recent` を取得 → `appState.notifications` 更新 → バッジ再描画。
- 初期化時（起動シーケンス内）にも 1 回 `refreshNotifications()` を呼ぶ。初回で
  `notifSeenAt` が未設定なら now を保存（過去分でバッジが満杯にならないように）。

### パネル

- ベルクリックで `notifPanel` を開閉（開くだけでは既読にしない）。
- パネル内容: ヘッダーに「通知」＋「クリア」ボタン、続けて1件ずつ:
  「[LINE/Drive] 勘定科目 ¥金額 ・ 顧問先名 ・ 相対時刻」。未読の行は強調表示。
- **クリア**ボタン: `notifSeenAt = now` を保存 → バッジ 0、未読強調を解除（一覧自体は残る）。

### クリックでジャンプ

- 通知行クリックで:
  1. `appState.matchingTab = item.clientId || 'unassigned'`
  2. `location.hash = '#/matching-results'`
  3. パネルを閉じる
  4. 描画後、`data-voucher-img="<id>"`（該当証憑要素）へスクロールし、一時的にハイライト

### エラーハンドリング

- `inbound-recent` 取得失敗時はトースト等を出さず `console.warn`。バッジ・一覧は前回値を維持。

## テスト方針

### バックエンド（vitest・実 Postgres、モックなし）

`tests/routes/vouchers-inbound-recent.test.ts`:
- line/drive/manual・別firm の Voucher を作成し、`GET /api/vouchers/inbound-recent` が
  line/drive のみ・自 firm のみ・`uploadedAt` 新しい順で返すこと、`limit` を順守すること。
- `vendor` / `amount` / `account` / `clientName`（clientId から解決）が期待通り入ること。

### フロントエンド

- `node --check script.js`。
- 手動: LINE/Drive で証憑追加 → 15 秒以内にバッジが増える → ベルを開くと一覧、クリック→突合結果へ
  ジャンプ＆ハイライト → 「クリア」でバッジ 0。

## 受入基準

1. LINE/Drive で証憑が追加されると、15 秒以内に右上ベルの未読バッジが増える。
2. ベルを開くと、追加された証憑が新しい順に1件ずつ（source/勘定科目/金額/顧問先/時刻）表示される。
3. 通知をクリックすると、その証憑の顧問先の突合結果へ遷移し、該当証憑がハイライトされる。
4. 「クリア」ボタンを押すと未読バッジが 0 になる（ベルを開いただけでは既読にならない）。
5. manual アップロードや別 firm の証憑は通知に出ない。
6. 既存の「追加されました」トースト（spec 27）の挙動は変わらない。
7. 通知 API が失敗してもアプリの他機能は壊れない。
