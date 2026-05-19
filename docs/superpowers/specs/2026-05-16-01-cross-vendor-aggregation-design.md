# 01. freee/MF クロスベンダー集約

改善案: ① freee/MF クロスベンダー集約

> ⑧（既存ソフトとの機能重複回避）は **08 が原典の横断指針**。本スペックの F6（ジャンプリンク・出所列）は 08 の原則 O1〜O3 を具体実装するもので、08 がレビュー観点を提供する。

## 背景
- 牧野氏: 「各クライアントのfreeeとマネフォを見に行かなくてよくて、この画面一つで情報が取れたら楽」
- 牧野氏: 「マネフォはフリーのデータを見に行けないわけだから、そこがbookmeeの取れるところ」
- 08 との合わせ技: bookmee は OCR / 自動仕訳の生データ表示は freee/MF に任せ、**横串の集約レイヤー**に集中する。これがプロダクトの差別化の核。

## ゴール
1. 顧問先ごとの「使用会計ソフト（freee / MF / 両方）」がひと目で分かる
2. freee顧客とMF顧客を**同一の進捗ダッシュボード**で扱える
3. レビュー対象の取引・残高・証憑が、ベンダーをまたいで**統一フォーマット**で表示される
4. ベンダー連携の最終同期時刻と件数・状態が常に確認できる
5. bookmee は freee/MF の生取引画面を**そのまま再現しない**（重複機能の排除）

## 本番アーキ前提
- **MF**: 実API連携（OAuth2 + REST）。`server/src/adapters/mf-api.ts` を実装
- **freee**: モック継続。`server/src/adapters/freee-mock.ts` で固定データ返却
- 共通インターフェース `VendorAdapter`:
  ```ts
  interface VendorAdapter {
    fetchEntries(clientExternalId: string, since?: Date): Promise<RawEntry[]>;
    fetchReceipts(clientExternalId: string, since?: Date): Promise<RawReceipt[]>;
    fetchMatchings(clientExternalId: string): Promise<RawMatching[]>;
    fetchBalances(clientExternalId: string, period: Period): Promise<RawBalance[]>;
  }
  ```
- DBへの取り込みは `sync-service.ts` 経由（09 の SWR 戦略に準拠）

## DBモデル（09 の Prisma スキーマで定義済み）
- `Client.vendor: 'freee' | 'mf' | 'both'`
- `VendorSync` モデル（`vendor`, `lastSync`, `status`, `count`, `errorMsg`）
- `Entry.source`, `Receipt.source`, `Matching.source`（'mf'|'freee'）

## API

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/clients` | vendor 含む顧客一覧 |
| GET | `/api/sync-status` | 全顧客の VendorSync 集計（サイドバー用） |
| POST | `/api/clients/:id/sync` | 強制同期（裏でMF API 叩く） |
| GET | `/api/mf/oauth/start?clientId=…` | MF認可開始（管理者操作） |
| GET | `/api/mf/oauth/callback` | コールバック → token 保存 |

## 機能要件

### F1. ベンダーバッジ
`renderClients()` の顧問先ストリップに、社名行の右下に小バッジ:
- `vendor === 'freee'` → `<span class="pill freee">freee</span>`
- `vendor === 'mf'`    → `<span class="pill mf">MF</span>`
- `vendor === 'both'`  → 上記2バッジを並べる

### F2. ベンダーフィルタ
`renderProgress()` の `work-tabs` に「ベンダー別」タブを追加。クリックで顧問先テーブルを `vendor` ごとにグルーピング表示。

### F3. 統一エントリ表示（出所列）
`renderTable(rows, columns)` の出力ヘッダに「出所」列を末尾追加。各行の `source` を pill で描画。

### F4. 同期ステータスカード（サイドバー）
`index.html` の `.integration-card` に `id="integrationCard"` を付与し、`renderIntegrationCard()` が描画:
- `GET /api/sync-status` の結果から、freee行とMF行に分けて表示
- 各行: ステータスドット（緑/橙/赤）+ ベンダー名 + 「全顧客◯／◯ OK」+「最終同期: ◯時間前」
- ボタン「いま取り込む」 → `POST /api/clients/:id/sync` を全 vendor=mf 顧客で叩く（簡易実装は順次）

### F5. クロスベンダーKPI
`summary-grid` に5枚目のサマリーカードを追加（ID `#vendorSyncValue`）:
- 「ベンダー横断同期」: 全顧問先の `VendorSync.status === 'ok'` 割合 ％
- `GET /api/summary` の戻り値から取る

### F6. 重複機能の排除（08 の具体実装）
証憑・消込・仕訳テーブルの各行に「freee/MFで開く」リンクボタンを追加（モックURLでよい）。
`buildVendorDeepLink(row, vendor)` を server 側ヘルパで持つ：
- MF: `https://moneyforward.com/.../entries/{id}` 形式（実URL不明な場合はプレースホルダ）
- freee: 同様
- フロントは `row.deepLink` を表示するだけ

## index.html 変更
- `.integration-card` の中身を削除し `id="integrationCard"` を付与
- `summary-grid` 末尾に `<article class="summary-card"><span>ベンダー横断同期</span><strong id="vendorSyncValue">—</strong><small>全顧問先平均</small></article>` を追加

## script.js 変更

| 関数 | 変更 |
|---|---|
| `loadClients()` 新設 | `GET /api/clients` で `clients[]` を取得 |
| `loadSyncStatus()` 新設 | `GET /api/sync-status` で `appState.syncStatus` 更新 |
| `loadSummary()` 新設 | `GET /api/summary` でサマリーKPIを取得 |
| `renderClients` | ベンダーバッジ描画（API由来データ） |
| `renderSummary` | 5枚目 `#vendorSyncValue` を更新 |
| `renderTable` | 「出所」列＋「freee/MFで開く」ボタン |
| `renderProgress` | 「ベンダー別」タブのグルーピング |
| 新規 `renderIntegrationCard()` | サイドバー連携カード描画 |
| `triggerSync(clientId)` 新設 | `POST /api/clients/:id/sync` |

## サーバ側実装ポイント

### `mf-api.ts`
- OAuth2 認可コードフロー（`/api/mf/oauth/start` → `/callback`）
- access_token / refresh_token を `Client` モデル拡張列 `mfAccessToken`, `mfRefreshToken`, `mfTokenExpiresAt` に保存（暗号化は将来課題）
- HTTP Client は undici
- レート制限: 失敗時 `Retry-After` 尊重
- 取得データを Prisma に upsert（`@@unique([source, sourceEntryId])` で冪等）

### `freee-mock.ts`
- 既存 `script.js` の clients[] のうち freee 想定の取引・証憑・消込を `prisma/seed.ts` から流用
- 同インターフェース、固定データ返却

### `sync-service.ts`
- `syncClient(clientId, options?)` で vendor ごとに対応 adapter を呼ぶ
- 結果を upsert + `VendorSync` 更新
- 失敗時は `VendorSync.status='error'` + `errorMsg`

## styles.css 追加
- `.pill.freee`, `.pill.mf` の配色（freee=#0e8be5系, MF=#39a85a系）
- `.integration-card .sync-row { display:flex; align-items:center; gap:8px }`
- `.status-dot.ok / .warn / .error` の3色
- `.vendor-link { font-size:11px; color:#0e8be5; text-decoration:underline }`

## スコープ外
- freee 実API連携（モック維持）
- token 暗号化保存
- 取引重複検知（freee と MF の同一取引）
- ディープリンク URL の本物の構築仕様

## 受入基準
- [ ] MF OAuth 認可フローが動作し、token が DB に保存される
- [ ] `vendor='mf'` 顧客で `POST /api/clients/:id/sync` を叩くと、Entry/Receipt/Matching が DB に取り込まれる
- [ ] `vendor='freee'` 顧客は `freee-mock.ts` の固定データが取り込まれる
- [ ] 各顧問先カードに vendor バッジが表示される
- [ ] 進捗ダッシュボード「ベンダー別」タブで freee/MF/両方 の3グループに分かれる
- [ ] 仕訳・証憑・消込テーブルに「出所」列があり、行ごとに freee / MF が表示される
- [ ] サイドバー連携カードに最終同期時刻＋ステータス色（緑/橙/赤）が出る
- [ ] サマリーカード「ベンダー横断同期」が VendorSync 集計の％を表示
- [ ] テーブル各行「freee/MFで開く」ボタンがある
