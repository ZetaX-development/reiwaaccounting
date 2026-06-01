# spec 26 会計事典ナレッジ RAG — 本番投入ハンドオフ

別スレッド（Railway のトークン・URL 共有済み）で本番作業をするための引き継ぎ。

## 1. 現在の状態

- **実装は完了・ローカル検証済み・全コミット済み**（`main` ブランチ、spec 26 の 6 コミット）。
- ローカル dev Postgres は seed＋embedding 済み（118 チャンク / embedding 118 件）。
- **残作業は「本番 Railway Postgres へのデプロイ＋seed」だけ**。コード変更は不要。

関連 commit（`main`）:
```
feat(spec 26): 会計事典markdownをrepoに取り込み
feat(spec 26): KnowledgeChunkモデルとマイグレーション追加
feat(spec 26): 会計事典markdownチャンカーを追加
feat(spec 26): ナレッジ検索サービスを追加
feat(spec 26): ナレッジ取り込みスクリプトを追加
feat(spec 26): RAG生成プロンプトに会計事典解説を注入
```

参照: spec `docs/superpowers/specs/2026-06-01-26-knowledge-rag-design.md` / plan `docs/superpowers/plans/2026-06-01-26-knowledge-rag.md`

## 2. 本番構成の前提（重要）

- 本番ホスト = **Railway**（project `auto accounting`、env=production、app service `bookmee`、DB service `Postgres`）。
- **アプリデータ DB = Railway 内蔵 Postgres**（`DATABASE_URL`）。`JournalPattern` も `KnowledgeChunk` も**ここ**に入る。**Supabase ではない**（Supabase は認証/JWT 専用、Supabase MCP からアプリDBは見えない）。
- ローカルから Railway Postgres に繋ぐには **`DATABASE_PUBLIC_URL`**（内部ホスト `*.railway.internal` はローカルから解決不可）。Railway → `Postgres` service → Variables で取得。
- デプロイ = 手動 Railway CLI（GitHub 自動デプロイ不可）。`railway.toml` の startCommand が `npx prisma migrate deploy && node dist/server.js`。

## 3. やるべきこと（順番）

### Step 1: デプロイ（テーブル自動作成）
```bash
cd /home/kkouta/busines/reiwaaccounting-gaki
RAILWAY_TOKEN=<project token> railway up --service bookmee
```
- startCommand の `prisma migrate deploy` が **Railway Postgres に `KnowledgeChunk` テーブルを自動作成**する（マイグレーション `20260602001511_add_knowledge_chunk` 済み・SQL はクリーン）。
- ※デプロイにはローカル作業ツリーがそのまま上がる。並行 spec 27 の未コミット変更を含めたくない場合は注意。

### Step 2: ナレッジを本番 Railway Postgres に seed
```bash
cd /home/kkouta/busines/reiwaaccounting-gaki/server
DATABASE_URL='<Railway Postgres の DATABASE_PUBLIC_URL>' \
OPENAI_API_KEY='<本番 OpenAI キー>' \
npm run seed:knowledge
```
- 期待ログ: `[seed:knowledge] total=118 created=118 updated=0 embeddingsSeeded=118 embeddingsSkipped=0`
- **冪等**。再実行すると `created=0 updated=118`、未生成 embedding のみ追加される。
- DATABASE_URL を CLI で渡せば server/.env の dev 向け値を上書きできる（prisma の dotenv は既存 env を上書きしない）。

### Step 3: 既存パターンも未投入なら seed（必要時）
本番 Railway Postgres に `JournalPattern`（178件）が無ければ:
```bash
DATABASE_URL='<DATABASE_PUBLIC_URL>' OPENAI_API_KEY='<本番キー>' npm run seed:patterns
```
確認: `SELECT count(*) FROM "JournalPattern";` が 0 なら未投入。

### Step 4: 検証
本番 DB に対して:
```sql
SELECT count(*) total, count("embeddingJson") with_emb FROM "KnowledgeChunk";
-- 期待: 118 | 118

SELECT count(*) FILTER (WHERE title LIKE '%目次%' OR title LIKE '%索引%') AS frontmatter_leaked
FROM "KnowledgeChunk";
-- 期待: 0
```
アプリ動作確認: 摘要が空の MF 仕訳に対する AI レビューで、難しめのケース（固定資産/退職金/クレカ 等）の生成プロンプトに【参考解説（会計事典）】が入り、`JournalAiReview` 等に反映されること。

## 4. ハマりどころ / 注意

- **seed 先を間違えない**: Supabase ではなく **Railway Postgres（DATABASE_PUBLIC_URL）**。Supabase MCP では届かない。
- **OPENAI_API_KEY 必須**: 無いと embedding が全 skip（`embeddingsSeeded=0`）。その場合チャンクは入るが意味検索が効かず、キーワード一致（勘定科目名）フォールバックのみになる。再 seed で後追い可能（冪等）。
- **embedding 無しでも壊れない**: ナレッジ 0 件 or embedding 無しでも、`generateMemoWithRag` は spec 23 と同じ挙動にフォールバック（【参考解説】節を出さない）。デモが最低限動く保険。
- **マイグレーションのドリフト**: 既にクリーンな SQL でコミット済みなので、本番 `migrate deploy` は `KnowledgeChunk` 作成のみ。Voucher 列には触れない。
- **モデル**: 摘要生成は `gpt-4o`、embedding は `text-embedding-3-small`、OCR は `OPENAI_VISION_MODEL`（既定 gpt-5）。本番 Railway env にこれらのキーが設定されていること。

## 5. ロールバック

- ナレッジを使いたくない場合は `DELETE FROM "KnowledgeChunk";` で全削除すれば、`findSimilarKnowledge` が空配列を返し spec 23 挙動に戻る（コード変更不要）。テーブル自体は残してよい。
