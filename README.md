# Bookmee

税理士事務所向け AI 月次レビュー SaaS のプロトタイプ。

## 開発環境セットアップ

### 必要なもの
- Node.js 20+
- Docker Desktop（または互換のCompose対応ランタイム）
- npm

### 初回セットアップ
```bash
# 1. Postgres を起動
docker compose up -d postgres

# 2. サーバー依存をインストール
cd server
npm install

# 3. 環境変数を用意
cp .env.example .env

# 4. DBマイグレーションとシード
npm run prisma:migrate
npm run seed
```

### 開発サーバー起動
```bash
cd server
npm run dev
```
ブラウザで http://localhost:3000/ を開く。

### テスト
```bash
cd server
npm test
```

## 構成
- フロントエンド: ルートの `index.html` / `styles.css` / `script.js`（Vanilla JS）
- バックエンド: `server/`（Node.js + TypeScript + Fastify + Prisma）
- DB: PostgreSQL 16（Docker Compose）

## 設計ドキュメント
`docs/superpowers/specs/` に各機能の設計書、`docs/superpowers/plans/` に実装プラン。
