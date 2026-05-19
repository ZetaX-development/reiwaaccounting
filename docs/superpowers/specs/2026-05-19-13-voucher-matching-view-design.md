# 13. 突合結果ビュー（サイドバー新規）

作成日: 2026-05-19

## 位置づけ

spec 10–12 で揃った Voucher × MF 仕訳の突合結果を **per-client で一覧確認** するためのサイドバービュー。A→B→C→D の **D**。証憑登録ビュー（spec 10）と独立して、突合の結果のみを見せる読み取り中心の画面。

## ゴール

1. サイドバー「業務」配下に「突合結果」を追加（証憑登録の次）
2. 顧問先タブで切り替え、選択中顧問先の突合結果を 2 セクションで表示:
   - **突合済み**: voucher サムネ + 抽出フィールド + 対応する MF 仕訳の概要を横並びカードで
   - **未突合 / 要対応**: voucher サムネ + 抽出フィールド + 「再突合」ボタン
3. 顧問先未割当て / OCR 不足の voucher も「要対応」セクションに混ぜて表示
4. 既存の証憑登録画面を変更しない（読みやすさ重視で分離）

## アクター

- **税理士事務所スタッフ**: 突合結果をレビュー、再突合判断

## データソース

- `GET /api/vouchers?clientId=<id>` で voucher 一覧（spec 10–12 で揃ってる）
- `GET /api/clients/:id` で MF 仕訳一覧（既存）。voucher.matchedEntryId を entries の sourceEntryId と突き合わせて表示

新規 API は **追加しない**。

## UI レイアウト

```
+---------------------------------------------+
| [タブ: 渋谷カフェ ▲ | 青山デザイン | …]      |
+---------------------------------------------+
| ✓ 突合済み (3 件)                          |
+---------------------------------------------+
| [サムネ] OCR 抽出           MF 仕訳         |
|  ¥3,200    青山デザイン     雑費 ¥3,200    |
|            様              2026-05-15      |
|            2026-05-15      [仕訳IDコピー]   |
+---------------------------------------------+
| ⚠ 要対応 (1 件)                            |
+---------------------------------------------+
| [サムネ] ¥1,800            [再突合]         |
|          ハラペコステーキ   [顧問先変更▼]   |
|          2026-05-20         理由: AI推測    |
+---------------------------------------------+
```

## 画面遷移

- サイドバー「突合結果」をクリック → ビュー表示
- タブ切替で各顧問先の突合結果に切替
- 「未割当て」タブ = clientId null の voucher を表示（突合不可なので 要対応のみ）
- 再突合ボタン → POST /api/vouchers/:id/match → 数秒後リロード
- 顧問先変更ドロップダウン → PATCH /api/vouchers/:id

## フロント実装

### appState 追加

```js
matchingTab: 'shibuya-cafe',  // 初期は顧問先一覧の先頭
matchingVouchers: [],
matchingEntries: [],          // 選択中の client.entries キャッシュ
matchingLoadedTab: null,      // ガード（無限ループ防止、spec 10 と同パターン）
```

### renderMatchingResults()

`script.js` に追加。タブ + 突合済みセクション + 要対応セクションを HTML 生成。

### loadMatchingData(clientId)

並列で 2 つ fetch:
```js
const [vouchers, client] = await Promise.all([
  fetch(`/api/vouchers?clientId=${clientId}`).then(r => r.json()),
  fetch(`/api/clients/${clientId}`).then(r => r.json()),
]);
appState.matchingVouchers = vouchers;
appState.matchingEntries = client.entries || [];
```

### イベント配線

renderView の vouchers-register と同じパターンで:
- タブ click
- 再突合ボタン click
- 顧問先変更 dropdown change

## ナビ追加

`index.html` の業務セクション、証憑登録の次に:

```html
<button class="nav-item" data-view="matching-results">突合結果</button>
```

labels と labels.helper に対応エントリを追加:

```js
"matching-results": "突合結果",
```

```js
"matching-results": "アップロード済み証憑と MF 仕訳の突合結果を顧問先ごとに確認します。",
```

## スタイル

`styles.css` 末尾に `.matching-*` クラス群:
- `.matching-section` (header + body)
- `.matching-card-matched` (横並び flex)
- `.matching-card-pending` (1 列)
- 状態色は spec 12 の `match-ok / match-no / match-gray` を流用

## 受入基準

- [ ] サイドバー「突合結果」が出る
- [ ] 顧問先タブで切り替えると、その顧問先の突合済み / 要対応が表示される
- [ ] 突合済みカードに voucher サムネ + 抽出フィールド + 対応 MF 仕訳の概要が出る
- [ ] 要対応カードに 再突合ボタン + 顧問先変更が機能する
- [ ] 顧問先未割当て voucher は「未割当て」タブで一覧できる

## 非ゴール

- マッチングルールの編集 UI（±30 日を変更等、将来課題）
- 一括再突合 / 一括振り分け
- MF への書き戻し（zeimee は read-only）
