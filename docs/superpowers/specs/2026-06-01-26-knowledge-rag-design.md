# spec 26: 会計事典ナレッジを RAG に追加

- 日付: 2026-06-01
- ステータス: design
- 関連: [spec 23 RAG 仕訳 AI](2026-05-29-23-rag-journal-ai-design.md)

## 目的

仕訳摘要生成 RAG（spec 23）の知識ソースに、勘定科目事典（実務書）の解説テキストを追加する。

既存の `JournalPattern`（178 件）は「借方 1・貸方 1・摘要例・タグ」という固定構造で、**仕訳の形**は表現できるが、「**なぜその科目か / 個人・法人でどう違うか / 消費税区分 / 相手科目の選び方**」といった**判断の根拠となる解説プロース**を持たない。AI が `difficult` と判断するケースの多くは、まさにこの解説知識があれば判定できる。

書き起こし済みの markdown（2 ファイル、計約 300 ページ相当）を論理セクション単位でチャンク化し、embedding して、生成プロンプトに参考解説として注入する。

## 非ゴール（YAGNI）

- 書籍の仕訳例を `JournalPattern` 行へ変換しない（1 ページに ❶〜❾ ＋ 個人/法人 の枝分かれがあり爆発する。解説プロースも失われる）。
- pgvector は導入しない。既存パターン同様、embedding を JSON 文字列で保存しアプリ層で cosine を計算する（常駐プロセス前提、件数も数百規模で十分）。
- 前付け（はじめに・本書の特徴・目次）と索引はナレッジに取り込まない。
- 書籍の自動 OCR / PDF パースはしない。入力は整形済み markdown のみ。
- MF への書き戻しは一切しない（read-only ポリシー継続）。

## 入力データ

`/home/kkouta/poc/siwake/20260520_004.md`（前半 〜p.144）、`20260520_005.md`（後半 p.145〜索引）。
これらを repo 内 `server/src/data/knowledge/` にコピーして commit し、取り込みスクリプトのソースとする。

### markdown の構造

- セクション見出しは `## p.X ｜ <タイトル>`（タイトル付き）と `## p.X`（タイトル無し＝前セクションの「次頁に続く」）の 2 種。
- 1 論理セクションが複数ページにまたがる（タイトル付き行で始まり、後続のタイトル無し `## p.X` が継続）。
- 各セクションの典型要素: 概要文、`> 消費税区分：…`、`【増加取引】/【減少取引】`、借方/貸方の表、`- 相手科目：…`、`摘要例：…`、`◆仕訳例 ❶❷…`、`【個人】/【法人】` の枝分かれ、`※` の判断注記。
- 前付け・索引: 「はじめに」「本書の特徴」「目次」「索引」等のタイトル。

## データモデル

新規 Prisma モデル `KnowledgeChunk`:

```prisma
model KnowledgeChunk {
  id            String   @id @default(cuid())
  source        String   // 書名キー（例 'siwake-jiten'）
  page          String   // ページ範囲（例 'p.32-33'）
  title         String   // セクション見出し（例 '1-01 租税公課'）
  content       String   // markdown 本文（次頁結合済み・原文ママ）
  accounts      String[] // 抽出した勘定科目名（タイトル＋表セル由来）
  taxClass      String?  // 消費税区分（拾えた場合）
  tags          String[] // '個人' / '法人' 等
  embeddingJson String?  // text-embedding-3-small（1536次元）を JSON 文字列化
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([source, title])
  @@index([source])
}
```

`@@unique([source, title])` を upsert キーとし、再取り込みの冪等性を担保する。

## チャンク分割（純粋関数）

`server/src/services/knowledge-chunker.ts` に純粋関数 `chunkKnowledgeMarkdown(markdown: string, source: string): ParsedChunk[]` を置く。

ロジック:

1. `## ` 見出しでセクションに分割。
2. 見出しが `p.X ｜ <タイトル>` 形式（` ｜ ` を含む）なら**新チャンク開始**。`p.X` のみ（タイトル無し）なら**直前チャンクの本文に結合**し、`page` 範囲を更新（先頭ページ〜現ページ）。
3. タイトルが除外キーワード（`はじめに` / `本書の特徴` / `目次` / `索引` / `章扉` 等）にマッチするチャンクは破棄。先頭ページ群（目次まで）も同様に除外。
4. 各チャンクから機械抽出（正規表現）:
   - `accounts`: タイトル中の科目名（`N-NN <科目名>` パターン）＋本文の借方/貸方表セルに現れる勘定科目名を集約・重複排除。
   - `taxClass`: `> 消費税区分：<値>` 行から最初の値。
   - `tags`: タイトル末尾の `［個人／法人］` 等から `個人`/`法人` を付与。
5. 返り値は `{ source, page, title, content, accounts, taxClass, tags }`。

純粋関数なので TDD（Red→Green）。代表的な入力（タイトル付き＋継続ページ、前付け、科目解説）で boundary とメタ抽出を検証する。

## 検索サービス

`server/src/services/knowledge-service.ts`。`journal-pattern-service.ts` と同じ構造で実装し、`cosineSimilarity` / `generateEmbedding` は既存の export を再利用する（重複実装しない）。

- `loadKnowledgeCache()`: 全 `KnowledgeChunk` をメモリへ。`embeddingJson` をパースして number[] 化。
- `findSimilarKnowledge(queryText: string, topK = 3): Promise<KnowledgeChunkResult[]>`:
  - クエリ embedding を生成（既存 `generateEmbedding` を利用）。
  - コサイン類似度でランキング（主経路）。
  - `accounts`/`tags` がクエリ文字列に部分一致したらスコア加点（補助。既存 `tagMatchScore` と同方針）。
  - 主経路（cosine）と補助（keyword）を RRF 融合し上位 `topK`。
- `seedKnowledgeEmbeddings()`: `embeddingJson` が null/空のチャンクのみ embedding 生成して update（既存 `seedEmbeddings` と同パターン、冪等）。

## 生成への注入

`journal-rag-service.ts` の `generateMemoWithRag` を拡張:

- 既存の `findSimilarPatterns` に加えて `findSimilarKnowledge(queryText, 3)` を呼ぶ。
- `buildUserPrompt` に **【参考解説（会計事典）】** 節を追加し、取得チャンクの `title` ＋ `content` を上位 2〜3 件**そのまま**注入する（トリム等の小細工はせず、保守性を優先）。
- `buildSystemPrompt` に一文追加: 「参考解説（会計事典）が提示された場合は、勘定科目の選択・消費税区分・個人/法人の違いの判断根拠として活用してよい」。
- `RagResult` に `knowledgeUsed: string[]`（使用チャンク id）を追加し、トレーサビリティを残す。

注入量は「コスト無視・保守優先」の方針に従い固定（最大 3 件丸ごと）。

## 取り込みスクリプト

`server/scripts/seed-knowledge.ts` ＋ `package.json` に `"seed:knowledge": "tsx scripts/seed-knowledge.ts"`。

処理:
1. `server/src/data/knowledge/*.md` を読む。
2. `chunkKnowledgeMarkdown` でチャンク化。
3. `@@unique([source, title])` で upsert。
4. `seedKnowledgeEmbeddings()` で未生成分のみ embedding。
5. ログ: `total / created / updated / embeddingsSeeded / embeddingsSkipped`。

`.md` を編集 → `npm run seed:knowledge` 再実行で差分更新（冪等）。

## マイグレーション

CLAUDE.md「5. Prisma migration」の非対話 workaround 手順で `KnowledgeChunk` テーブルを追加する（`prisma migrate diff` → `migrate resolve --applied` → psql 適用 → `prisma generate`）。本番（Railway / Cloud Run）は起動時 `prisma migrate deploy` で自動適用される。

## テスト方針

CLAUDE.md「開発フロー」に準拠:

- `knowledge-chunker.ts`: 純粋関数。vitest で boundary 結合・前付け除外・メタ抽出を検証（外部依存なし）。
- `knowledge-service.ts`: 実 Postgres に `KnowledgeChunk` を投入し、`findSimilarKnowledge` の順位を検証。OpenAI embedding は既存方針どおりモック可（auxiliary service）。`cosineSimilarity` は純粋関数として直接テスト。
- `fileParallelism: false` を維持。`beforeEach` で `knowledgeChunk.deleteMany()`、`afterAll` で cleanup。
- 既存テストを壊さないこと（`generateMemoWithRag` のシグネチャ変更は後方互換＝新フィールド追加のみ）。

## 受入基準

1. `server/src/data/knowledge/` に 2 つの `.md` が commit されている。
2. `npm run seed:knowledge` が成功し、前付け・索引を除いた論理セクションが `KnowledgeChunk` に投入され、embedding が生成される。再実行しても重複行が増えない。
3. `chunkKnowledgeMarkdown` のユニットテストが green（継続ページ結合・前付け除外・メタ抽出）。
4. `findSimilarKnowledge` が、クエリ（例「自動車税を現金で支払った」）に対し租税公課セクションを上位に返す。
5. `generateMemoWithRag` の出力プロンプトに【参考解説（会計事典）】節が含まれ、`knowledgeUsed` が埋まる。
6. `npm test` が全 green。`npx tsc --noEmit` で新規エラーを出さない（既知の pre-existing エラーは対象外）。
