# 04. クライアント別リスクルール

改善案: ④ クライアント別リスクルール設定

## 背景
- 牧野氏: 「クライアントごとに見たいポイントを設定できるといい。リスクは全然違う」
- 過去に間違いやすかった科目・業種特性を**クライアント単位**で蓄積。AIルール画面を「業種テンプレ列挙」から「企業ごとのカスタムルール書き込み」へ再設計する。

## ゴール
1. ルールが顧問先ごとに登録・編集・削除できる
2. ルールには「業種テンプレ」と「カスタム」の2系統がある
3. ルールが「いつ・どの取引で・何回ヒットしたか」が見える
4. 過去のヒット履歴をもとに、AIルールパネルが「次もこの科目で要注意」を提示する
5. ルール変更が即座に他ビュー（レビュー、AI候補、依頼文）の優先度に反映する

## 本番アーキ前提
- データソースは `Rule`, `RuleHit` テーブル（09 で定義済み）
- 業種テンプレライブラリは `server/src/data/rule-templates.ts` に定数で持つ
- ルール変更時のタスク score 再計算は `task-service.ts` の `recomputeTaskScores(clientId)` がトリガ

## DBモデル（09 で定義済み）
- `Rule { id, clientId, type, industry, title, detail, severity, active, createdBy, createdAt }`
- `RuleHit { id, ruleId, at, target, outcome }`
- `Client.industry: '広告制作'|'飲食'|'EC'|'不動産'|'その他'`
- `Task.ruleId` (任意): どのルールが当該タスクの根拠か

## API

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/rule-templates?industry=...` | 業種別テンプレ一覧 |
| GET | `/api/clients/:id/rules` | 顧問先のルール一覧（hits件数も含む） |
| POST | `/api/clients/:id/rules` | ルール追加（type/industry/title/detail/severity） |
| PATCH | `/api/rules/:id` | 編集・active切替 |
| DELETE | `/api/rules/:id` | 削除 |
| GET | `/api/rules/:id/hits` | ヒット履歴 |

ルール追加/編集/削除/active切替時、サーバは関連 `Task.score` を `recomputeTaskScores(clientId)` で更新。

## 機能要件

### F1. AIルールビュー再設計（`renderRules`）
2カラム構成:

**左: ルール一覧**
- `GET /api/clients/:id/rules` を描画
- `message-card` 単位、severity pill (高/中/低)、active トグル、ヒット件数、最終ヒット日
- 「編集」「削除」「履歴」ボタン

**右: ルール追加パネル**
- 「業種テンプレから追加」セレクタ → `GET /api/rule-templates?industry=...`
  - 該当業種のテンプレを一覧、ワンクリックで追加（`POST /api/clients/:id/rules` with `type='template'`）
- 「カスタムルールを追加」フォーム
  - title / detail / severity → `POST /api/clients/:id/rules` with `type='custom'`

### F2. ルールヒット履歴展開
「履歴」ボタン押下で `GET /api/rules/:id/hits` を呼び、その場でカード下に時系列展開。再押下で折りたたみ。

### F3. レビューセンターでのルール根拠リンク
`renderDashboard()` の各タスクカード「AI根拠」を、`Task.ruleId` から該当ルールへのリンクに変更。
クリックで `appState.activeView = 'rules'` + 該当カードへスクロール。

### F4. AIパネル `#ruleHits` の強化
`renderAiPanel()` の AIルール一致リスト:
- severity 順にソート + ヒット回数バッジ
- 直近30日のヒット数閾値超で「次の取引でも要注意」マーク

### F5. 業種フィールド
`Client.industry` を表示。AIルールビュー右上に「業種: 広告制作」のような表示。
変更は運用設定から。

### F6. ルール変更の即時反映
ルール追加/削除/active切替で:
- サーバが `recomputeTaskScores(clientId)` を実行
- フロントは `loadTasks(clientId)` を再実行 → `render()`
- 結果として既存タスクの優先度が変動（`Task.score` 再計算）

`recomputeTaskScores` 簡易ロジック:
- アクティブな Rule を取得
- 各 Task について、ルール条件にヒットしたら severity 加点（high=+10, mid=+5, low=+2、上限100）
- 「ルール条件のヒット」は MVP として `Task.title` `Task.note` の部分一致で判定

## index.html 変更
基本なし（`renderRules` 内で全DOM生成）。
AIパネルの AIルール一致 `insight-card` 内に `<a id="goToRules">編集</a>` を入れる。

## script.js 変更

| 関数 | 変更 |
|---|---|
| `loadRules(clientId)` 新設 | `GET /api/clients/:id/rules` |
| `loadRuleTemplates(industry)` 新設 | `GET /api/rule-templates?industry=...` |
| `addRule(clientId, body)` 新設 | `POST /api/clients/:id/rules` |
| `updateRule(id, body)` 新設 | `PATCH /api/rules/:id` |
| `deleteRule(id)` 新設 | `DELETE /api/rules/:id` |
| `loadRuleHits(id)` 新設 | `GET /api/rules/:id/hits` |
| `renderRules` | 2カラム再設計、編集/削除/トグル/履歴展開 |
| `renderDashboard` | AI根拠リンクを ruleId 経由に |
| `renderAiPanel` | severity 順ソート＋ヒット件数 |
| 新規イベント | `add-rule-template`, `add-rule-custom`, `edit-rule`, `delete-rule`, `toggle-rule-active`, `expand-rule-history`, `goto-rule` |

## サーバ側実装詳細

### `rule-service.ts`
```ts
async function addRule(clientId, body) {
  const rule = await prisma.rule.create({ data: { ...body, clientId } });
  await recomputeTaskScores(clientId);
  return rule;
}
```

### 業種テンプレ
```ts
// server/src/data/rule-templates.ts
export const ruleTemplates = {
  '広告制作': [
    { title: '広告費は過去6回の消費税区分を優先', detail: '...', severity: 'mid' },
    { title: '役員名義カードは証憑必須', detail: '...', severity: 'high' },
    // ...
  ],
  '飲食': [...],
  'EC': [...],
  '不動産': [...],
};
```

## styles.css 追加
- `.pill.severity-high { background:#fde2e7; color:#8a2035 }`
- `.pill.severity-mid  { background:#fff4d6; color:#7a5400 }`
- `.pill.severity-low  { background:#e3f1ff; color:#1d4f80 }`
- `.rules-2col { display:grid; grid-template-columns: 1.4fr 1fr; gap:16px }`
- `.rule-history-row { font-size:12px; color:#5c6675; padding:6px 10px; border-top:1px dashed #e5e7eb }`

## スコープ外
- ルールDSL（条件式の柔軟入力）— title + severity + detail のみ
- ルール自動学習（過去誤りからの推薦）— 表記モックのみ
- ルール版管理（履歴ロールバック）

## 受入基準
- [ ] AIルールビューが2カラム（左:一覧 / 右:追加）になる
- [ ] 業種テンプレから1クリックでルール追加できる
- [ ] カスタムルールを title / detail / severity で追加できる
- [ ] active トグルで `PATCH /api/rules/:id` が呼ばれ、即座にタスク score が更新される
- [ ] severity 別の pill が3色で表示される
- [ ] 「履歴」を押すと `RuleHit` がカード下に時系列展開する
- [ ] レビューセンターの「AI根拠」リンクから該当ルールへジャンプできる
- [ ] AIパネルのルール一致が severity 順にソート＋ヒット件数バッジ付き
