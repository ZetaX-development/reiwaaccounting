# Bookmee

税理士事務所向け AI 月次レビュー SaaS のプロトタイプ。

## 開発環境セットアップ

### 必要なもの
- Node.js 20+
- Docker Desktop（または互換の Compose 対応ランタイム）
- npm

### 初回セットアップ（クローン直後の 1 回だけ）
```bash
# 1. Postgres（開発用 DB, ポート 5432）を起動
docker compose up -d postgres

# 2. サーバー依存をインストール
cd server
npm install

# 3. 環境変数を用意（OPENAI_API_KEY などを埋める。下の「環境変数」参照）
cp .env.example .env

# 4. DB マイグレーション + シード（4 顧問先のデモデータ投入）
npm run prisma:migrate
npm run seed
```

## システムの起動 / 停止

### 起動（毎回これだけ）
```bash
# 1. Postgres が止まっていたら起動（起動済みなら不要）
docker compose up -d postgres

# 2. 開発サーバー起動（tsx watch。ファイル変更で自動リロード）
cd server
npm run dev
```
→ ブラウザで **http://localhost:3000/** を開く。

> **メモ:** `npm run dev` はこのターミナル（またはセッション）が閉じると止まる。
> セッションをまたいで動かし続けたいときは Docker で起動する（下記）。

### Docker で常駐起動（セッションに依存させたくない場合）
```bash
docker compose up -d            # postgres + server を両方起動
# 停止
docker compose stop server
```
`docker-compose.yml` の `server` サービスは `restart: unless-stopped` なので、
マシン再起動後も自動で立ち上がる。

### 停止
```bash
# 開発サーバー（npm run dev）は Ctrl+C
# Postgres を止める場合
docker compose stop postgres
# 全コンテナを止める
docker compose down            # ボリュームは残る（データは消えない）
```

### 状態確認
```bash
curl -s http://localhost:3000/api/health        # {"status":"ok",...} が返れば生きてる
docker compose ps                                # コンテナの稼働状況
```

## 環境変数（`server/.env`）

| 変数 | 用途 | 無いとどうなる |
|---|---|---|
| `DATABASE_URL` | 開発用 Postgres 接続 | 起動不可 |
| `OPENAI_API_KEY` | 証憑 OCR + 仕訳ドラフト生成 | 画像アップロードはできるが OCR が走らず `pending` のまま |
| `OPENAI_VISION_MODEL` | OCR モデル（既定 `gpt-5`） | 既定値で動く |
| `MF_CLIENT_ID` / `MF_CLIENT_SECRET` | MoneyForward OAuth 連携 | MF 連携不可（モック / 既存データのみ） |
| `OUTREACH_CHANNEL` | 顧客への問い合わせ送信先（`mock`/`email`/`line`） | 既定 `mock`（コンソール出力のみ） |
| `SENDGRID_API_KEY` | Email 送信（OUTREACH_CHANNEL=email 時） | メール送信失敗 |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | LINE 連携 / 問い合わせ | LINE 機能不可 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Drive 連携 | Drive 連携不可 |

`.env` はコミットしない（`.gitignore` / `.dockerignore` で除外済み）。

## テスト

テストは **本番 DB を汚さない専用 DB（ポート 5433, tmpfs）** で走る。

```bash
# 初回だけ: テスト用 Postgres 起動 + マイグレーション + シード
docker compose --profile test up -d postgres-test
cd server
npm run test:db:setup
DATABASE_URL=postgresql://bookmee:bookmee_test@localhost:5433/bookmee_test \
  npx tsx prisma/seed.ts

# テスト実行（以降はこれだけ。自動で 5433 を使う）
npm test
```

## デモデータの掃除

`npm run seed` は 4 顧問先（青山デザイン / 渋谷カフェ / 日本橋工業 / 横浜メディカル）と
ダミー仕訳を投入する。手動 UI 検証で特定の顧問先だけにしたいとき:

```bash
# 例: 日本橋工業だけ残す
docker compose exec -T postgres psql -U bookmee -d bookmee \
  -c "DELETE FROM \"Client\" WHERE id IN ('aoyama-design','yokohama-medical','shibuya-cafe');"

# 顧問先の MF 由来ダミー仕訳だけ消す（OCR 由来のドラフトは残る）
docker compose exec -T postgres psql -U bookmee -d bookmee \
  -c "DELETE FROM \"Entry\" WHERE \"clientId\"='nihonbashi-kogyo';"
```
※ `npm test` / `npm run seed` を再実行すると復活する。

## 本番デプロイ（GCP Cloud Run）

```bash
# prod イメージのビルド確認（ローカル）
docker build -f server/Dockerfile.prod -t bookmee:prod .

# Cloud Run へデプロイ（例）
gcloud builds submit --tag gcr.io/<project>/bookmee
gcloud run deploy bookmee \
  --image gcr.io/<project>/bookmee \
  --set-env-vars DATABASE_URL=...,OPENAI_API_KEY=... \
  --port 3000
```
`server/Dockerfile.prod` は起動時に `prisma migrate deploy` を実行する。
`server/Dockerfile`（dev 用, tsx watch）と `docker-compose.yml` は `.gcloudignore` で
ビルドコンテキストから除外され、本番には含まれない。

## 構成
- フロントエンド: ルートの `index.html` / `styles.css` / `script.js`（Vanilla JS）
- バックエンド: `server/`（Node.js + TypeScript + Fastify + Prisma）
- DB: PostgreSQL 16（開発 5432 / テスト 5433）
- 認証 / DB（本番想定）: Supabase

## 設計ドキュメント
`docs/superpowers/specs/` に各機能の設計書、`docs/superpowers/plans/` に実装プラン。
開発の流儀・テスト方針・既知の注意点は `CLAUDE.md` を参照。
