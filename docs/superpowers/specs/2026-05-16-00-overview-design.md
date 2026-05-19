# Bookmee 改善設計 — 概要 & スペック索引

作成日: 2026-05-16

## ねらい
顧客インタビュー（牧野氏／足立氏）から抽出した8つの改善案を、**本番アーキテクチャ**（フロント=既存Vanilla維持、バック=Node.js+TS+PostgreSQL）の上に段階実装するための設計セット。

## アーキテクチャ前提
詳細は [`09-system-architecture-design.md`](./2026-05-16-09-system-architecture-design.md) を参照。要点:
- **フロント**: 既存の `index.html` / `styles.css` / `script.js` を維持。`script.js` を `fetch()` ベースの API クライアントに改修
- **バック**: Node.js 20+ / TypeScript / Fastify / Prisma
- **DB**: PostgreSQL 16+（正規データ + MFキャッシュ + 通知ログ）
- **キャッシュ戦略**: Stale-While-Revalidate（MF APIから取得した取引・証憑・残高をDBにキャッシュし、閾値超過時に裏で再取得）
- **MF**: 実API連携（OAuth2 + REST + 同期ジョブ）
- **freee**: モック維持（同インターフェース `VendorAdapter` の `freee-mock.ts`）
- **通知**: メール / Slack / Chatwork / LINE WORKS は**実送信**
- **認証・権限**: 実装しない（将来課題）
- **OCR・実AI推論**: 実装しない。既存の擬似スコアを継続

## 共通前提（全スペック共通）
1. **UIシェル維持**: `index.html` のサイドバー9ビュー、ヘッダー、サマリーグリッド、メイン+AIパネル2カラム構造を保持。
2. **既存命名・スタイルに追従**: `pill`, `setting-row`, `message-card`, `row-action` 等のCSSクラスを再利用。新規スタイルも同命名規則。
3. **データソースはAPI**: `script.js` は API レスポンスを描画する。ローカル固定モック `clients[]` は **seed.ts に移行**して DB 投入用に転用。
4. **API/DB変更はPrismaスキーマで管理**: モデル変更時は `prisma migrate dev` で必ずマイグレーション化する。
5. **DBモデルは09で集中定義**: `Client`, `Task`, `Rule`, `Thread`, `ReceiptPolicy` 等の Prisma スキーマは 09 が一元管理。01〜08 は「09 で定義済みモデルを使う」立場。

> 注: 「VendorAdapter パターン（MFは実装、freeeはモック）」は 01 / 09 の責務であり、共通前提ではない（02〜08 は vendor を意識しない）。

## 設計ドキュメント索引

| # | タイトル | 改善案 | 主な改修対象（要約） |
|---|---|---|---|
| 00 | 概要 & 索引（本書） | — | — |
| 01 | freee/MF クロスベンダー集約 | ① | MF 実API連携 + freee モック / `VendorAdapter` パターン / `Client.vendor` ベンダーバッジ / `Entry`/`Receipt`/`Matching` の `source` 列 / 進捗ダッシュボードの「ベンダー別」タブ / サイドバー連携カード（同期状態） / サマリーKPI 5枚目「ベンダー横断同期」 |
| 02 | スタッフ→税理士 承認ワークフロー | ② | `Task.stage`/`assignee`/`approver` の遷移API / `TaskHistory` 履歴 / ロール切替セレクタ / レビューセンター stage 別表示 / スタッフ差戻しビュー再設計 / 承認履歴展開 / サマリーKPI 差替 |
| 03 | 顧問先連絡チャンネル一元化 | ③ | 通知アダプタ4本（Email/Slack/Chatwork/LINE WORKS）の**実送信** / `Thread` 履歴 / 顧問先連絡ビュー3カラム再設計 / `formatForChannel` クライアント整形 / 失敗時の自動再試行（5段階バックオフ） / 未送信件数集計 / AIパネルの「チャンネル最適化」 |
| 04 | クライアント別リスクルール | ④ | `Rule`/`RuleHit` の CRUD API / 業種テンプレライブラリ / AIルールビュー2カラム再設計 / `Task.score` の即時再計算 / レビューセンターからルール根拠ジャンプ / AIパネル severity ソート＋ヒット件数 / `Client.industry` |
| 05 | 月次 vs 期末モード切替 | ⑤ | `Client.mode` 切替API / 月次/期末モード別の KPI 集計 / レビューセンター・進捗ダッシュボードの列差替 / `YearendCheck` チェックリスト / AIパネル モード別メッセージ / 運用設定の一括変更表 |
| 06 | UI極限シンプル化（横断指針） | ⑥ | （横断指針）`labels` 中央集約 / 専門用語の禁止リスト / 1カード3ボタン制約 / 自然文KPI / 空状態表現 / `helper-line` / `friendlyError` / API英語コードを labels 経由で日本語化 |
| 07 | 証憑不足の自動検出＋依頼文生成 | ⑦ | `ReceiptPolicy`/`Client.receiptPolicyOverrides` の編集API / `computeMissingReceipts` 派生計算 / `Entry.receiptStatus` の MF同期時判定 / 証憑・消込ビュー3セクション再設計 / `generateReceiptRequest` 依頼文生成 → 03 へ流す / AIパネル不足通知 / KPI差替 |
| 08 | 機能重複の回避（横断指針） | ⑧ | （横断指針）bookmee の Yes/No 境界定義 / 「ジャンプ」ファーストUI / 読み取り専用方針（Entry/Receipt/Matching の書き込み API 非公開） / 同期遅延の明示 / freee は `freee-mock.ts` のまま |
| 09 | システムアーキテクチャ | — | スタック / ディレクトリ構成 / Prisma スキーマ全体 / REST API 一覧 / SWRキャッシュ / MF OAuth / 通知4本実装詳細 / 環境変数 / デプロイ |

> 改善案 ⑧ は **08（横断指針）が原典**。01 の F6（ジャンプリンク・出所列）は ⑧ の具体実装で、08 が定める原則 O1〜O3 に従う。

## 推奨実装順

依存関係（02 / 07 が 03 の `POST /api/messages` を呼ぶ）を踏まえ、03 を中盤に前倒し:

1. **09 (アーキ基盤)** — フロント/バック分離、DB、Prisma スキーマ、Fastify ルーティング、MF OAuth 雛形、freee モック、共通サイドカー（Bull/Redis 等）
2. **01** — MF 実連携が動き、`Entry`/`Receipt`/`Matching` が DB に乗る。サイドバー連携カード、ベンダーバッジ、出所列、サマリーKPI 5枚目
3. **03（基盤＋API）** — `Thread` モデル、`POST /api/messages`、4チャンネルアダプタ、再試行ジョブ。最低 1 チャンネルが実送信できる状態
4. **02** — 承認ワークフロー。「依頼文」ボタンで 03 の portal にジャンプ可能
5. **04** — リスクルール CRUD、`Task.score` 再計算
6. **07** — 不足検出 → `generateReceiptRequest` → 03 で送信が一気通貫
7. **05** — モード切替、KPI/レビュー/進捗の表示分岐
8. **06 / 08** — 横断指針として、上記 1〜7 の各実装PRでレビュー観点として参照（独自の実装ステップは持たない）

> **依存メモ**: 03 を 02・04・07 より先に置くのは「02 の差戻し依頼文・07 の不足依頼文」が `POST /api/messages` を叩くため。03 を先に最小実装しておけば、後続 PR で機能を呼ぶだけで済む。
> もし 03 を後に回す場合は、02・07 の「依頼文」ボタンは 03 完成までは textarea プリフィルのみとし、送信統合は別 PR で行う旨を各 PR で明記すること。

## 06 / 08 の扱い（横断指針）
- **独立した実装ステップを持たない**。スペック本体に書かれた「実装上のチェック」「具体タスク」は、上記 1〜7 の各 PR に分割して反映する
- 各 PR レビュー時、06 の P1〜P5（禁止語・3ボタン・自然文）と 08 の O1〜O4（ジャンプ・読取専用・同期遅延・境界）をチェックリストとして用いる
- 06/08 自身の PR は「`labels` 定数の整備」「ジャンプリンク用 `buildVendorDeepLink` ヘルパ」など**横断ヘルパーの追加だけ**を扱う

## 全スペック共通のスコープ外
- 認証・権限・マルチテナント
- freee 実API連携（モック継続）
- OCR / 実AI推論
- 監査ログ・データエクスポート機能
- マルチリージョン・高可用性構成
- 本番デプロイ詳細（Railway/Fly.io/Render などの選択は別判断）

## 全スペック共通の受入基準
- [ ] 既存の9ビューが API データで回帰なく描画される
- [ ] `index.html` の DOM 構造変更は新規追加のみ（既存ID削除・改名なし）
- [ ] Prisma マイグレーションが `prisma migrate dev` で再現できる
- [ ] `prisma/seed.ts` が現状のモックデータ相当を投入できる
- [ ] 新規 API は Zod でバリデーションされ、エラーは `{error:{code,message}}` 形式で返る
