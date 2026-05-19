# 07. 証憑不足の自動検出＋依頼文生成

改善案: ⑦ 証憑不足の自動検出＋依頼文生成

## 背景
- 足立氏: 「一番滞るのは顧客からの資料不足。月100仕訳のうち90本はAPIで処理できる。残り10本の証憑不足が業務を止める」
- 仕訳類型ごとに「証憑必要 / 不要」のルールを持ち、不足を自動検出して 各チャンネルへの文面を自動生成する。
- 「最後の10件」を消し込むのが本機能のミッション。

## ゴール
1. 仕訳類型ごとに「証憑必要 / 不要」のルールが設定できる
2. 仕訳に対する証憑の有無が自動判定される（MF実データ + freee モック）
3. 不足証憑の一覧が顧問先別にまとめて見える
4. 不足項目から依頼文が1クリックで生成される
5. 依頼文は 03（連絡チャンネル一元化）と組み合わせて、適切なチャンネルへ実送信される

## 本番アーキ前提
- `Entry.receiptStatus` は MF同期時に `sync-service.ts` が判定・保存
- 不足検出は `receipt-service.ts` の `computeMissingReceipts(clientId)` で派生計算（DB照会のみ、純関数寄り）
- 依頼文の生成は `receipt-service.ts` の `generateReceiptRequest(clientId, entryIds)`
- 実送信は 03 の `POST /api/messages` 経由

## DBモデル（09 の Prisma スキーマで定義済み）
- `ReceiptPolicy { account PK, requiresReceipt, requiresApproval, exemptUnder, notes }`
- `Client.receiptPolicyOverrides` (JSON: `{ '広告宣伝費': { requiresReceipt: false }, ... }`)
- `Entry.receiptStatus`: `'matched'|'missing'|'partial'|'na'`

## API

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/receipt-policies` | 全科目のポリシー |
| PATCH | `/api/receipt-policies/:account` | 既定値の編集 |
| PATCH | `/api/clients/:id/receipt-overrides` | 顧問先別オーバーライド編集 |
| GET | `/api/clients/:id/missing-receipts` | 不足リスト派生 |
| POST | `/api/clients/:id/receipt-requests` | 依頼文生成（送信は別API） |
| POST | `/api/entries/:id/mark-not-required` | 個別に不要マーク |

`POST /api/clients/:id/receipt-requests` の body:
```json
{ "entryIds": ["e_001","e_002"], "channel": "email" }
```
レスポンス:
```json
{ "subject": "5月月次のご確認資料のお願い",
  "body": "...",
  "channel": "email",
  "originRef": "rr_xxx" }
```

## 機能要件

### F1. 自動検出ロジック（サーバ側）
`computeMissingReceipts(clientId)`:
- 該当顧問先の `Entry` を取得
- 各 entry の `account` について `ReceiptPolicy` を引く（顧問先 override 反映）
- `requiresReceipt: true` かつ `receiptStatus !== 'matched'` を不足
- `exemptUnder` 金額未満は除外
- 戻り値:
  ```ts
  Array<{ entryId, account, amount, vendor, occurredAt, reason, priority }>
  ```
- priority は `score` 相当の数値（既存 entries の score を流用、無ければ 50 既定）

`render()` 時にフロントが `GET /api/clients/:id/missing-receipts` を都度叩く。
件数が大きい顧客は SWR キャッシュ対象（短めTTL: 5分）。

### F2. 証憑・消込ビューの再設計（`renderReceipts`）
3セクション構成:

**上段: 不足アラート**
- 不足件数を大きく表示
- 「不足◯件・依頼文を作成」ボタン → F3

**中段: 不足証憑テーブル**
- 列: 日付 / 科目 / 取引先 / 金額 / 不足理由 / 優先度 / アクション
- アクション:
  - 「依頼文に追加」（複数選択して F3 へ）
  - 「freee/MFで証憑を見る」（08 の指針に沿うジャンプリンク。手動添付UIは作らない）
  - 「不要として除外」（`POST /api/entries/:id/mark-not-required`）

**下段: 既存の証憑紐付けテーブルと消込テーブル**（API取得した `Receipt` `Matching` を表示）

### F3. 依頼文の自動生成
不足証憑テーブルでチェックした entryIds をまとめて依頼文化:
1. ユーザーが複数選択 → 「依頼文を作成」ボタン
2. フロントが `POST /api/clients/:id/receipt-requests` を叩く
3. レスポンスで返ってきた `subject` `body` を `appState.activeView = 'portal'` に切替後、`#portalDraft` に流し込み
4. 顧問先連絡ビューで「いま送る」または「予約送信」を選択（03の責務）

サーバ側 `generateReceiptRequest`:
- 顧問先名、敬称、現在期、締切日（`Client.fiscalYearEnd` か運用設定の月次締切）から本文を組立
- 不足項目を箇条書きに（科目・金額・日付・取引先）
- channel に応じて簡易整形（実送信前に `formatForChannel` で再整形可）

### F4. AIパネルの不足通知
`renderAiPanel()` の `bookmeeChat`:
- 不足証憑が3件以上ある場合: 「証憑が◯件不足しています。お客さまに今日中に依頼するのがおすすめです」を追加表示
- データソース: `GET /api/clients/:id/missing-receipts` の件数

### F5. ヘッダーKPIの差替え
`#receiptValue` の `小` 部分（不足件数）を不足リスト件数に同期。
`#missingValue` も同期。
`GET /api/summary` の `missingReceiptCounts` で取得。

### F6. 仕訳類型ポリシーの設定UI
`renderSettings()` に「証憑ルールの設定」セクション追加:
- `GET /api/receipt-policies` で全科目を取得
- 各科目を `setting-row` で表示
- トグルで `requiresReceipt` / `requiresApproval` を切替 → `PATCH /api/receipt-policies/:account`
- 顧問先別オーバーライドへのリンク（顧問先選択中は `PATCH /api/clients/:id/receipt-overrides`）

## index.html 変更
基本なし（`renderReceipts` と `renderSettings` 内で全DOM生成）。
ヘッダーボタン群に「不足証憑から依頼を作る」ショートカットを追加するなら:
- `topbar-actions` に `<button class="ghost-action" id="quickRequestMissing">不足証憑→依頼文</button>`

## script.js 変更

| 関数 | 変更 |
|---|---|
| `loadMissingReceipts(clientId)` 新設 | `GET /api/clients/:id/missing-receipts` |
| `loadReceiptPolicies()` 新設 | `GET /api/receipt-policies` |
| `updateReceiptPolicy(account, body)` 新設 | `PATCH /api/receipt-policies/:account` |
| `markNotRequired(entryId)` 新設 | `POST /api/entries/:id/mark-not-required` |
| `createReceiptRequest(clientId, entryIds, channel)` 新設 | `POST /api/clients/:id/receipt-requests` |
| `renderReceipts` | 3セクション再設計（不足アラート、不足テーブル、既存テーブル） |
| `renderAiPanel` | 不足件数による追加メッセージ |
| `renderSummary` | 不足件数を反映 |
| `renderSettings` | 証憑ルールの設定セクション追加 |
| 新規イベント | `add-to-request`, `mark-not-required`, `quick-request-missing`, `goto-vendor` |

## サーバ側実装詳細

### `receipt-service.ts`
```ts
async function computeMissingReceipts(clientId: string) {
  const [client, entries, policies] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.entry.findMany({ where: { clientId } }),
    prisma.receiptPolicy.findMany(),
  ]);
  const policyByAccount = Object.fromEntries(policies.map(p => [p.account, p]));
  const overrides = client.receiptPolicyOverrides ?? {};
  return entries
    .filter(e => {
      const policy = { ...policyByAccount[e.account], ...overrides[e.account] };
      if (!policy?.requiresReceipt) return false;
      if (policy.exemptUnder && e.amount < policy.exemptUnder) return false;
      return e.receiptStatus !== 'matched';
    })
    .map(e => ({
      entryId: e.id,
      account: e.account,
      amount: e.amount,
      vendor: extractVendorFromDescription(e.description),
      occurredAt: e.occurredAt,
      reason: e.receiptStatus === 'partial' ? '一部のみ添付' : '領収書未添付',
      priority: e.score ?? 50,
    }))
    .sort((a, b) => b.priority - a.priority);
}
```

### `generateReceiptRequest`
- テンプレートはサーバ側に持つ（i18n対応のため）
- channel ごとに簡易整形（最終形は 03 の `formatForChannel` でクライアント側調整可）

### MF同期時の `receiptStatus` 判定
`sync-service.ts`:
- MF API から `Entry` と `Receipt` を取得
- 同一 occurredAt + 同金額の Receipt がある → `matched`
- 一部のみ（金額差あり / 部分一致） → `partial`
- 全くない → `missing`
- 科目が `requiresReceipt: false` → `na`

## styles.css 追加
- `.missing-alert { padding:14px; background:#fff5f6; border:1px solid #fbd5db; border-radius:10px; display:flex; justify-content:space-between; align-items:center }`
- `.priority-bar { width:60px; height:6px; background:#e5e7eb; border-radius:3px }`
- `.priority-bar > i { display:block; height:100%; background:#dc2f55; border-radius:3px }`

## 03（連絡チャンネル一元化）との連携点
- `POST /api/clients/:id/receipt-requests` の戻り値を `POST /api/messages` の body に流して送信
- `originRef` に `receiptRequestId` を入れる
- 送信完了時に該当 `Entry` 群に「依頼済み」フラグ（`Entry.requestedAt`）を立てる ← 本スペック範囲

## 06（UIシンプル化）との連携点
- 「不足証憑」「依頼文を作成」など、ボタン文言は `labels` 経由
- 不足アラートは「あと◯件、お客さまに連絡すれば終わります」のような自然文
- 空状態は「今日はありません」

## 08（重複回避）との連携点
- 「証憑を手動添付」UIは作らない → 「freee/MFで証憑を見る」ジャンプリンクへ置換
- OCR・パース等は実装しない

## スコープ外
- 実OCRによる証憑自動添付
- 証憑のスキャン・PDF パーサ
- 顧問先ポータルからのアップロード受付
- 過去の不足→送付→受領のSLA計測
- 受信メッセージから添付ファイルを自動取り込み

## 受入基準
- [ ] 仕訳類型ごとの証憑要件ルールが定義され、`PATCH /api/receipt-policies/:account` で編集できる
- [ ] 顧問先別に `PATCH /api/clients/:id/receipt-overrides` でオーバーライド可能
- [ ] MF同期時に `Entry.receiptStatus` が自動判定される
- [ ] `GET /api/clients/:id/missing-receipts` が不足リストを返す
- [ ] 証憑・消込ビュー上段に不足件数アラートが出る
- [ ] 不足証憑テーブルから「依頼文に追加」が複数選択できる
- [ ] 「依頼文を作成」で `POST /api/clients/:id/receipt-requests` が呼ばれ、生成文が顧問先連絡ビューに流れ込む
- [ ] そこから 03 の「いま送る」で実チャンネルに送信される
- [ ] 送信成功時に該当 Entry に `requestedAt` が立つ
- [ ] AIパネルが不足3件以上で追加メッセージを出す
- [ ] サマリーKPI（証憑回収率の不足件数）が同期する
