# 05. 月次 vs 期末モード切替

改善案: ⑤ 月次 vs 期末モードの切り分け

## 背景
- 牧野氏: 「月次決算を真面目に締めるかはクライアント次第。3ヶ月後にやっと数字わかる世界も普通」
- 小規模顧客（売上1億未満）は月次より期末・確定申告時期にニーズが集中
- bookmee を「月次モード」と「期末クローズモード」の2モードで設計し直す

## ゴール
1. 顧問先ごとに「月次モード / 期末クローズモード」が設定できる
2. 全体ヘッダーで現在表示中のモードが一目で分かる
3. モードによってサマリーKPI、タスクの優先順位、レビューチェックリストが切り替わる
4. モード切替が他ビュー（レビュー、進捗、ルール）に即時反映する

## 本番アーキ前提
- `Client.mode` に永続化
- 期末チェックは `YearendCheck` テーブル（09 で定義済み）
- KPI集計は `GET /api/summary?clientId=...` がモードに応じて返す

## モード仕様

### 月次モード（既定: 中堅以上の顧問先）
- 重視KPI: レビュー完了率、所長確認待ち、証憑回収率、差戻し中
- レビューセンター: 月次の異常点、消費税区分、前月比増減
- 締切感: 月初〜月中で完結

### 期末クローズモード（小規模顧問先）
- 重視KPI: 年間累計の網羅性、未着手月数、申告書草案準備度、税務調整チェック数
- レビューセンター: 期末論点（減価償却、棚卸、貸引、未払計上、税効果、消費税確定）を ToDo 化
- 締切感: 決算月+2ヶ月後の申告期限

## DBモデル（09 で定義済み）
- `Client.mode: 'monthly'|'yearend'`
- `Client.fiscalYearStart`, `Client.fiscalYearEnd`
- `Client.yearendKpi` (JSON: monthsCovered, monthsTotal, filingReadiness, adjustmentChecks, adjustmentDone)
- `YearendCheck { id, clientId, title, note, status, order }`

## API

| Method | Path | 用途 |
|---|---|---|
| PATCH | `/api/clients/:id/mode` | モード切替 |
| GET | `/api/clients/:id/yearend-checklist` | 期末チェックリスト |
| PATCH | `/api/yearend-checks/:id` | 期末チェック項目の status 更新 |
| GET | `/api/summary?clientId=...` | mode に応じたKPI（4枚 or 5枚） |

## 機能要件

### F1. モードトグル
ヘッダー `topbar` 社名タイトル横に小トグル:
- pill 風セグメント `[月次] [期末]`
- 選択で `PATCH /api/clients/:id/mode` → `loadClients()` → `render()`
- 顧問先ストリップにも mode 小バッジ

### F2. サマリーKPIの切替
`renderSummary()` を mode 分岐。`GET /api/summary?clientId=...` の戻り値で値と文言を更新:

**月次モード**: レビュー完了率／所長確認待ち／証憑回収率／差戻し中／（01の）ベンダー横断同期

**期末モード**:
- 期内処理進捗 (`monthsCovered/monthsTotal × 100%`)
- 期末調整チェック (`adjustmentDone/adjustmentChecks`)
- 申告草案準備度 (`filingReadiness%`)
- 残申告日数 (`fiscalYearEnd + 2ヶ月 - today`)

サマリーカードの DOM 構造（IDと枚数）は同じにし、表示文言と値だけ差し替える。
**01（クロスベンダー集約）が先に入ると 5 枚目「ベンダー横断同期」(`#vendorSyncValue`) が追加される**:
- 月次モード: 5枚目は「ベンダー横断同期」（01のまま）
- 期末モード: 5枚目は「残申告日数」に文言と値だけ差し替え（同じ ID `#vendorSyncValue` を使い回し）

01 が未実装の段階でも本スペックは独立に実装可（4枚構成）。

### F3. レビューセンターの切替
`renderDashboard()`:
- 月次モード: 既存ロジック（`Task` ベース）
- 期末モード: `GET /api/clients/:id/yearend-checklist` をカード化。各項目に「着手」「完了」「メモ」ボタン → `PATCH /api/yearend-checks/:id`

### F4. 進捗ダッシュボードの切替
`renderProgress()` の顧問先一覧テーブル:
- 月次モード: 既存列
- 期末モード: 列を差替え（顧問先 / 担当 / 期内月進捗 / 調整チェック / 申告準備度 / 申告残日数 / 次アクション）

### F5. AIパネルのモード対応メッセージ
`renderAiPanel()` の `bookmeeChat`:
- 期末モードなら「期末クローズ中。残り◯項目の期末調整があります」を追加
- 月次モードは現状文面

### F6. モード設定の運用設定タブ
`renderSettings()` に「顧問先モード一覧」セクション追加:
- 全顧問先の mode を一覧表示・一括変更
- 各行に `PATCH /api/clients/:id/mode` ボタン

## index.html 変更
- `topbar` 内、`<h1>` の右に `<div class="mode-toggle"><button data-mode="monthly" class="mode-btn active">月次</button><button data-mode="yearend" class="mode-btn">期末</button></div>`

## script.js 変更

| 関数 | 変更 |
|---|---|
| `updateClientMode(id, mode)` 新設 | `PATCH /api/clients/:id/mode` |
| `loadYearendChecklist(id)` 新設 | `GET /api/clients/:id/yearend-checklist` |
| `updateYearendCheck(id, body)` 新設 | `PATCH /api/yearend-checks/:id` |
| `renderClients` | 社名カードに mode 小バッジ |
| `renderSummary` | mode 分岐 |
| `renderDashboard` | 期末モードは yearendChecklist を描画 |
| `renderProgress` | 期末モードは列差替 |
| `renderAiPanel` | 期末モード時の追加メッセージ |
| `renderSettings` | 顧問先モード一覧 |
| 新規 `renderModeToggle()` | ヘッダートグルの active 状態を更新 |
| 新規イベント | `.mode-btn` クリック |

## サーバ側実装詳細
- `summary-service.ts` に `getSummary(clientId)` を実装。`Client.mode` を見て月次/期末の集計を返す
- 期末モード時は `Client.yearendKpi` を派生計算（`monthsCovered` は `Entry` の存在月数、`adjustmentDone` は `YearendCheck.status='done'` 件数）

## styles.css 追加
- `.mode-toggle { display:inline-flex; gap:4px; padding:3px; background:#f5f7fa; border-radius:8px; margin-left:12px }`
- `.mode-btn { padding:4px 10px; font-size:12px; border:none; background:transparent; cursor:pointer; border-radius:6px }`
- `.mode-btn.active { background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.06); font-weight:bold }`
- `.client-card .mode-badge.monthly / .yearend` の色

## スコープ外
- モード自動推定（売上規模からの推奨）
- 申告書出力フォーマット
- 期末特有の税務計算エンジン
- モード混在（一部勘定だけ月次、他は期末）

## 受入基準
- [ ] ヘッダー社名横にモードトグル `[月次] [期末]` が表示される
- [ ] トグル切替で `PATCH /api/clients/:id/mode` が呼ばれ、サマリーKPI 4枚（または5枚）が文言と値とも切替わる
- [ ] 期末モードでレビューセンターに `yearendChecklist` がカード表示される
- [ ] 期末モードで進捗ダッシュボードの列構成が切替わる
- [ ] 期末モードのAIメッセージが追加表示される
- [ ] 運用設定に「顧問先モード一覧」表があり、ここからも切替できる
- [ ] 顧問先ストリップの社名カードに mode 小バッジが出る
