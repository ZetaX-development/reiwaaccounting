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
- スコープは `mf-api.ts` の `MF_SCOPES` に列挙。**`*.write` は絶対に足さない**（spec 08 の O2: zeimee は read-only。書き戻し機能を追加してはいけない）
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
