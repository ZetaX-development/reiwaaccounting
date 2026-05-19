# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

税理士事務所向け AI 月次レビュー SaaS のプロトタイプ。Vanilla JS フロントエンドを Fastify が静的配信し、`/api/*` で REST を提供。MoneyForward Cloud Accounting には実 API（OAuth2、read-only）で接続、freee はモックのまま。

設計の根拠はすべて `docs/superpowers/specs/2026-05-16-00..09-*-design.md` にある。`09-system-architecture-design.md` が技術選定と全体像、`00-overview-design.md` が機能横断の方針。実装で迷ったらまず該当 spec を読む。

## 開発コマンド

すべて `server/` 配下で実行する。

```bash
docker compose up -d postgres            # Postgres 16（初回のみ）
cd server && npm install
cp .env.example .env                      # MF_CLIENT_ID 等を埋める
npm run prisma:migrate                    # マイグレーション & generate
npm run seed                              # 既存 script.js のモックを DB に投入
npm run dev                               # tsx watch、http://localhost:3000
npm run build && npm start                # 本番ビルド
npm test                                  # vitest run（全テスト）
npx vitest run tests/services/sync-service.test.ts   # 単一ファイル
npx vitest run -t "isStale"               # 名前パターン
npx prisma migrate dev --name <name>      # スキーマ変更後のマイグレーション
npx prisma studio                         # DB を GUI で確認
```

テストは **実 Postgres に接続して seed 済みクライアント（例 `aoyama-design`）を前提に動く**。`vi.mock` は使っておらず、`tests/setup.ts` が `DATABASE_URL` を docker-compose のデフォルトに合わせている。新しいテストもこの方針を踏襲する。ベンダー API（MF/freee）のモックも基本書かない（後述）。

## アーキテクチャ要点

### 1 リポジトリ・2 レイヤ

- ルート直下の `index.html` / `styles.css` / `script.js` がフロント（Vanilla）。`server.ts` で `@fastify/static` の root を `repoRoot`（`server/src/server.ts` から `../..`）にして直接配信している。フロントは fetch で `/api/*` を叩くだけ。
- `server/src/` に Fastify + Prisma バックエンド。レイヤは `routes/ → services/ → adapters/`、データは `lib/prisma.ts`。
- ルートは `server.ts` で個別に `register` する明示的構成（自動ロードしない）。新ルートを足したら `buildApp()` に追記する。

### Vendor adapter パターン

`src/adapters/vendor-adapter.ts` の `VendorAdapter` を MF（実 API）と freee（モック）が実装。`sync-service.ts` が `client.vendor` で振り分ける。RawEntry / RawReceipt / RawMatching が adapter ↔ service 間のドメイン境界。新ベンダー追加時はこの interface に揃える。

### 「DB キャッシュではなくライブ取得」原則

**MF/freee 由来のデータは DB に保存して読み返さない**。`Entry` / `Receipt` / `Matching` テーブルは seed と互換のために残っているが、ユーザ要件として常に API から取り直す。

具体的には `services/client-service.ts:getClientById` が、`mfAccessToken` を持つクライアントについて毎リクエスト `mfApiAdapter.fetchEntries` を呼んで「ライブオーバーレイ」する。同関数の `getLiveMfEntries` を `receipt-service` などが共有する。新機能を作るときも、ベンダー由来データを参照するなら DB ではなく live API から取る方向で書く。

`POST /api/clients/:id/sync` は `VendorSync.lastSync` を更新するだけで、Entry を書き込まない（同期は「成功した最後の時刻」のメタ情報のみ）。

### MoneyForward OAuth と 2 つのホスト

詳細は `docs/MF-OAUTH-SETUP.md`。実装で覚えておくこと:

- 認可・トークン: `MF_AUTH_BASE_URL`（`https://api.biz.moneyforward.com`）の `/authorize` / `/token`
- データ API: `MF_ACCOUNTING_BASE_URL`（`https://api-accounting.moneyforward.com`）の `/api/v3/...`
- 旧 `MF_BASE_URL` は互換のために env スキーマに残してあるが `mf-api.ts` は読まない（`.env` は空でよい）
- アクセストークンは 1h、`ensureToken()` が残り 60 秒で自動 refresh、`mfRefreshToken` を更新
- スコープは `mf-api.ts` の `MF_SCOPES` に列挙。**`*.write` は絶対に足さない**（spec 08 の O2: bookmee は read-only。書き戻し機能を追加してはいけない）
- 取得した office の `name` を `Client.name` に上書きし、`code` を `Client.mfExternalId` に保存する設計（spec 01）

### 環境変数の遅延ロード

`src/env.ts` は Zod スキーマ + Proxy で「最初に読まれた時に validate」する singleton。`bootstrap.ts` が `dotenv/config` を行い、`server.ts` の最上行で import される。**テストは `bootstrap.ts` を import せず**、`tests/setup.ts` が `process.env` を直接設定するので、テストで env を上書きしたい時は `__resetEnvCache()` を呼んで再評価させる。

### Prisma スキーマの 2 層構造

- `Client` 直下のスナップショット列（`progress`, `tasksOpen`, `risk`, `receipt`, `missing`, `diff`, `matches`, `ownerLabel`, `chatMessage`, `messageDraft`）はダッシュボード表示用のキャッシュ。書き込み時に再計算する想定。
- `Entry` / `Receipt` / `Matching` はベンダーから取り込んだ生データの保存先だが、上記「ライブ取得」原則により実際の読み取りは API オーバーレイが主。

### フロント

`script.js` は 100KB 超の単一 Vanilla JS。状態は module-level 変数、レンダは `innerHTML` で行う。フレームワーク化の予定はない（spec 06 で「過剰な抽象化を避ける」方針）。

## 作業時の流儀

- このリポジトリでは Claude 自身が実装を書く（Codex 等に委託しない）。
- 仕様変更や新機能は、対応する spec 番号（`docs/superpowers/specs/2026-05-16-NN-*.md`）を参照したうえで行う。spec を変えるべきと思ったら先に spec を更新する。
- MF / freee に書き込む実装は禁止（read-only ポリシー）。
- 「データを DB にキャッシュして高速化したい」と感じたら、その前に live fetch で十分な要件か確認する。原則として API 直叩き。

## 開発フロー (spec 10〜16 で確立)

spec 10 以降の voucher パイプライン（証憑登録 / OCR / 突合 / 仕訳ドラフト / Drive 連携 / LINE 連携）はすべて以下のフローで実装した。次の機能も同じ流儀でやる。

### 1. spec → plan → execute

1. **設計 (`docs/superpowers/specs/YYYY-MM-DD-NN-*-design.md`)** — 機能の目的、データモデル、API、UI、テスト方針、受入基準、非ゴールを書き切る。実装に入る前に user に見せて方針合意する。
2. **plan (`docs/superpowers/plans/YYYY-MM-DD-NN-*.md`)** — spec を 8〜15 個の小さい Task に分解。各 Task は「Files」「Step 1〜N」「Commit」を含む。
3. **execute** — `superpowers:subagent-driven-development` パターンで Task ごとに implementer → spec compliance reviewer → code quality reviewer の 3 ステップ。各 Task 完了で個別 commit。

### 2. TDD discipline

各 Task の Step は **Red → Green → Refactor → Commit** の順:

1. 失敗テストを書く
2. テストを走らせて **fail を目視確認**（モジュール解決エラーや assert mismatch がメッセージに出ているか）
3. 実装を書く
4. テストを走らせて **pass を確認**
5. commit (TDD discipline を破ったら指摘してもらう)

例外: フロントの Vanilla JS は test framework 無し。`node --check script.js` の構文チェック + 手動 UI 検証で代用。

### 3. テストでモックを使う / 使わない判断

- **Prisma / DB**: モックしない。実 Postgres に繋ぐ。`beforeEach` で `prisma.<table>.deleteMany()`、`afterAll` で cleanup + `$disconnect`。seed のクライアント (`aoyama-design`, `shibuya-cafe`, `nihonbashi-kogyo`, `yokohama-medical`) を使う。
- **MF / freee の vendor adapter**: モックしない。spec 08 の方針通り、外部 API は信頼して直叩く（テストの遅さは許容）。
- **OpenAI / Google Drive / LINE 等のサービス API**: モック OK。これらは「会計データのソース」ではない（auxiliary service）。`vi.mock('openai', () => ({ default: vi.fn() }))` パターン or `vi.spyOn(service, 'fn')` で。
- **env**: `tests/setup.ts` が最低限を `process.env` にセット。テスト中で env を変える場合は `process.env.X = 'y'` + `__resetEnvCache()` を呼ぶ。

### 4. vitest 設定

- `server/vitest.config.ts` の `fileParallelism: false` を維持する。複数テストファイルが同じ Voucher テーブル等を `deleteMany` するので、並列実行すると DB レースで落ちる。

### 5. Prisma migration

通常は `npx prisma migrate dev --name <name>`。**Claude セッションは非インタラクティブなので prisma migrate dev が失敗することがある**。その場合の workaround:

```bash
TS=$(date +%Y%m%d%H%M%S) && mkdir -p prisma/migrations/${TS}_<name> \
  && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
       --to-schema-datamodel prisma/schema.prisma --script \
       > prisma/migrations/${TS}_<name>/migration.sql \
  && npx prisma migrate resolve --applied "${TS}_<name>" \
  && docker compose exec -T postgres psql -U bookmee -d bookmee \
       -f - < prisma/migrations/${TS}_<name>/migration.sql \
  && npx prisma generate
```

### 6. コミット運用

- 1 Task = 1 commit。複数機能を 1 commit にまとめない。
- `feat(spec NN): ...` / `fix(spec NN): ...` / `docs(spec NN): ...` / `test(spec NN): ...` / `chore(spec NN): ...` を使い分け。
- `Co-Authored-By: Claude ...` は付けない（user 設定）。

### 7. 既知の pre-existing TS エラー

`npx tsc --noEmit` で以下のエラーは spec 10 以降の作業対象外。**触らない**:

- `src/routes/mode.ts(44,48)`: `note: string | null | undefined` mismatch
- `src/server.ts(25,25)`: `loggerInstance` overload error
- `src/server.ts(63,3)`: Http2SecureServer assignment

新規ファイルでこの種類のエラーを出さないようにする。

### 8. seed の挙動と運用

`npm run seed` は 4 つの顧問先 (`aoyama-design` ZetaX MF 連携、`shibuya-cafe`, `nihonbashi-kogyo`, `yokohama-medical`) と各々の Entry / Receipt / Matching ダミーを投入する。**テストはこれらに依存**しているので、seed を消してはいけない。

ただし手動 UI 検証で「ダミーを消したい」ときは `Entry` / `Receipt` / `Matching` を `clientId` で `DELETE` する。Client 行自体は残す（MF OAuth 連携状態などが消えるため）。

### 8b. テスト用 DB は分離されている

dev (5432) と test (5433) で Postgres を分けている。`npm test` は自動で test DB を使う:

```bash
# 初回セットアップ
docker compose --profile test up -d postgres-test    # ポート 5433
npm run test:db:setup                                # migration 適用
DATABASE_URL=postgresql://bookmee:bookmee_test@localhost:5433/bookmee_test \
  npx tsx prisma/seed.ts                              # seed (4 顧問先)
npm test                                              # vitest 実行
```

- dev DB (5432) の Voucher / 設定は **テストで消えない**
- test DB は tmpfs (RAM) — コンテナ再起動で全部消える、CI でも軽量
- `tests/setup.ts` がデフォルトを 5433 にしているので `DATABASE_URL` を指定しなければ test DB を使う

### 8c. GCP デプロイ用ファイル

- `server/Dockerfile.prod` — production 用マルチステージビルド。Cloud Run / GKE 用
- `server/Dockerfile` — **dev のみ** (tsx watch + bind mount)。本番にデプロイしない
- `docker-compose.yml` — **dev のみ**
- `.gcloudignore` / `.dockerignore` でテスト / docs / docker-compose / dev Dockerfile / .env を除外

ビルド & ラン:

```bash
# ローカルで prod イメージを確認
docker build -f server/Dockerfile.prod -t bookmee:prod .
docker run -e DATABASE_URL=postgresql://... -p 8080:3000 bookmee:prod

# GCP Cloud Run へデプロイ (例)
gcloud builds submit --tag gcr.io/<project>/bookmee
gcloud run deploy bookmee \
  --image gcr.io/<project>/bookmee \
  --set-env-vars DATABASE_URL=...,OPENAI_API_KEY=...,... \
  --port 3000
```

prod Dockerfile は起動時に `prisma migrate deploy` を実行する。Cloud SQL の DATABASE_URL を渡せばスキーマも自動で揃う。

### 9. spec/plan ファイル番号

- `docs/superpowers/specs/YYYY-MM-DD-NN-<slug>-design.md`
- `docs/superpowers/plans/YYYY-MM-DD-NN-<slug>.md`

`NN` は通し番号。`00`〜`09` が初期 spec、`10`〜 が後続機能。新機能は次の番号を取る。

### 10. フロントの hash routing

`script.js` の view 切替は **URL hash (`#/dashboard` 等) が source of truth**。サイドバーをクリックすると `location.hash` が変わり、`hashchange` イベントで `applyHashRoute` が `appState.activeView` を更新して `render()`。新しい view を追加するときは:

1. `index.html` に nav button（`data-view="<view-id>"`）
2. `labels` / `labels.helper` にエントリ
3. `views` map に `<view-id>: () => render<View>()` を追加
4. URL hash は自動的に `#/<view-id>` になる（hash routing が data-view を hash に変換）
5. OAuth callback 等で特殊 hash が要るなら `viewFromHash` / `hashFromView` に分岐を足す

### 11. UI が壊れたときの典型的な原因

このプロジェクトの Vanilla JS は型がないので、以下のパターンが定期的に発生する:

- **`adaptApiClient` が positional array を返してた残骸**: API レスポンスを `{...}` のまま渡す。`[a, b, c]` に変換しない。
- **`activeView` が undefined になる**: nav-parent ボタン (data-view 無し) が一般 nav-item handler に拾われると activeView が undefined になり後段が crash。data-view の有無をガードする。
- **`currentClient()` が undefined**: clients が loadClientsFromApi 完了前。各 renderer の先頭で null guard を入れる。
- **無限ループ**: renderView が API 呼び出しを kick して、API のコールバックが renderView を呼ぶ。`loadedTab` 等のガード変数で抑止する。

### 12. ドラフト仕訳の形式は MF 準拠

`Voucher.draftJournalJson` は MF クラウド会計の仕訳 CSV 形式に揃える:

```ts
{
  transactionDate: 'YYYY-MM-DD',
  debit: { account, subAccount, partner, taxClass, invoiceNumber, amount },
  credit: { account, subAccount, partner, taxClass, invoiceNumber, amount },
  description: string,
  missingFields: string[],
  reasoning: string,
}
```

借方と貸方両方を AI に出させる。スタッフが MF に手入力するときコピペできる形にする。MF への自動転記は禁止 (read-only)。
