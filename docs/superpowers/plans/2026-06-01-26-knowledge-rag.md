# 会計事典ナレッジ RAG 追加 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 勘定科目事典の markdown を論理セクション単位でチャンク化・embedding し、既存 RAG 仕訳 AI（spec 23）の生成プロンプトに参考解説として注入する。

**Architecture:** 既存のパターン検索（`journal-pattern-service`）には一切触れず、新テーブル `KnowledgeChunk` ＋ 新サービス `knowledge-service` を並走させる。接続は `journal-rag-service.generateMemoWithRag` の1か所のみ（後方互換の追加）。ナレッジ未投入でも空配列フォールバックで spec 23 と同じ挙動を保つ。

**Tech Stack:** TypeScript / Fastify / Prisma 5 / PostgreSQL 16 / OpenAI (`text-embedding-3-small`, `gpt-4o`) / vitest

参照スペック: `docs/superpowers/specs/2026-06-01-26-knowledge-rag-design.md`

---

## ファイル構成

- Create: `server/src/data/knowledge/20260520_004.md`, `20260520_005.md` — 書籍ソース（repo にコピー）
- Modify: `server/prisma/schema.prisma` — `KnowledgeChunk` モデル追加
- Create: `server/prisma/migrations/<TS>_add_knowledge_chunk/migration.sql` — マイグレーション
- Create: `server/src/services/knowledge-chunker.ts` — 純粋関数チャンカー
- Test: `server/tests/services/knowledge-chunker.test.ts`
- Create: `server/src/services/knowledge-service.ts` — 検索・キャッシュ・embedding seed
- Test: `server/tests/services/knowledge-service.test.ts`
- Create: `server/scripts/seed-knowledge.ts` — 取り込みスクリプト
- Modify: `server/package.json` — `seed:knowledge` script
- Modify: `server/src/services/journal-rag-service.ts` — 注入ポイント
- Modify: `server/tests/services/journal-rag-service.test.ts` — knowledge-service モック追加＋新テスト

---

## Task 1: 書籍 markdown を repo にコピー

**Files:**
- Create: `server/src/data/knowledge/20260520_004.md`
- Create: `server/src/data/knowledge/20260520_005.md`

- [ ] **Step 1: ディレクトリ作成とコピー**

```bash
mkdir -p server/src/data/knowledge
cp /home/kkouta/poc/siwake/20260520_004.md server/src/data/knowledge/20260520_004.md
cp /home/kkouta/poc/siwake/20260520_005.md server/src/data/knowledge/20260520_005.md
```

- [ ] **Step 2: コピーを確認**

Run: `wc -l server/src/data/knowledge/*.md`
Expected: 2 ファイル、合計 ~10000 行

- [ ] **Step 3: Commit**

```bash
git add server/src/data/knowledge/
git commit -m "feat(spec 26): 会計事典markdownをrepoに取り込み"
```

---

## Task 2: KnowledgeChunk モデルとマイグレーション

**Files:**
- Modify: `server/prisma/schema.prisma`（`JournalPattern` モデル直後、:409 付近）
- Create: `server/prisma/migrations/<TS>_add_knowledge_chunk/migration.sql`

- [ ] **Step 1: schema.prisma にモデル追加**

`model JournalPattern { ... }` の閉じ `}`（:409）の直後に追記:

```prisma
model KnowledgeChunk {
  id            String   @id @default(cuid())
  source        String
  page          String
  title         String
  content       String
  accounts      String[]
  taxClass      String?
  tags          String[]
  embeddingJson String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([source, title])
  @@index([source])
}
```

- [ ] **Step 2: マイグレーション生成（非対話 workaround）＋ dev DB 適用**

`server/` で実行:

```bash
cd /home/kkouta/busines/reiwaaccounting-gaki/server
TS=$(date +%Y%m%d%H%M%S) && mkdir -p prisma/migrations/${TS}_add_knowledge_chunk \
  && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
       --to-schema-datamodel prisma/schema.prisma --script \
       > prisma/migrations/${TS}_add_knowledge_chunk/migration.sql \
  && npx prisma migrate resolve --applied "${TS}_add_knowledge_chunk" \
  && docker compose exec -T postgres psql -U bookmee -d bookmee \
       -f - < prisma/migrations/${TS}_add_knowledge_chunk/migration.sql \
  && npx prisma generate
```

Expected: `CREATE TABLE "KnowledgeChunk"` を含む SQL が生成され、`prisma generate` が成功

- [ ] **Step 3: テスト DB にも適用**

```bash
npm run test:db:setup
```

Expected: migrate deploy が新マイグレーションを test DB(5433) に適用

- [ ] **Step 4: 型生成を確認**

Run: `npx tsc --noEmit 2>&1 | grep -i knowledgechunk || echo "no KnowledgeChunk type error"`
Expected: `no KnowledgeChunk type error`（既知の pre-existing エラーは無視）

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(spec 26): KnowledgeChunkモデルとマイグレーション追加"
```

---

## Task 3: チャンカー（純粋関数）

**Files:**
- Create: `server/src/services/knowledge-chunker.ts`
- Test: `server/tests/services/knowledge-chunker.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`server/tests/services/knowledge-chunker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunkKnowledgeMarkdown } from '../../src/services/knowledge-chunker.js';

const SAMPLE = `# 20260520_004

> 文字起こし

---

## p.3 ｜ はじめに

本書の説明文。

---

## p.5-? ｜ 目次

目次の中身。

---

## p.32 ｜ 1-01 租税公課（そぜいこうか）［個人／法人］

> 消費税区分：**対象外**（課税／非課税）

税金の支払い。

| 借方 | 金額 | 貸方 | 金額 |
|------|------|------|------|
| 租税公課 | 50,000 | 現金 | 50,000 |

（次頁に続く）

---

## p.33

| 借方 | 金額 | 貸方 | 金額 |
|------|------|------|------|
| 貯蔵品 | 30,000 | 租税公課 | 30,000 |
`;

describe('chunkKnowledgeMarkdown', () => {
  it('excludes front matter (はじめに / 目次) and keeps account sections', () => {
    const chunks = chunkKnowledgeMarkdown(SAMPLE, 'siwake-jiten');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('1-01 租税公課（そぜいこうか）［個人／法人］');
  });

  it('merges continuation pages and records a page range', () => {
    const chunk = chunkKnowledgeMarkdown(SAMPLE, 'siwake-jiten')[0]!;
    expect(chunk.page).toBe('p.32-33');
    expect(chunk.content).toContain('租税公課');
    expect(chunk.content).toContain('貯蔵品'); // p.33 本文も結合
  });

  it('extracts accounts, taxClass and 個人/法人 tags', () => {
    const chunk = chunkKnowledgeMarkdown(SAMPLE, 'siwake-jiten')[0]!;
    expect(chunk.accounts).toContain('租税公課'); // タイトル由来
    expect(chunk.accounts).toContain('現金');     // 表セル由来
    expect(chunk.accounts).toContain('貯蔵品');
    expect(chunk.taxClass).toBe('対象外');
    expect(chunk.tags).toEqual(expect.arrayContaining(['個人', '法人']));
    expect(chunk.source).toBe('siwake-jiten');
  });
});
```

- [ ] **Step 2: テストを走らせて fail を確認**

Run: `cd server && npx vitest run tests/services/knowledge-chunker.test.ts`
Expected: FAIL（`chunkKnowledgeMarkdown` が未定義のモジュール解決エラー）

- [ ] **Step 3: 実装を書く**

`server/src/services/knowledge-chunker.ts`:

```ts
export interface ParsedChunk {
  source: string;
  page: string;
  title: string;
  content: string;
  accounts: string[];
  taxClass: string | null;
  tags: string[];
}

const EXCLUDE_TITLE_KEYWORDS = ['はじめに', '本書の特徴', '目次', '索引', '章扉', '科目一覧'];
const NON_ACCOUNT_CELLS = new Set(['借方', '貸方', '金額', '']);

interface Section {
  startPage: string;
  endPage: string;
  title: string;
  bodyLines: string[];
}

function normalizeAccount(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s*※.*$/, '').replace(/（.*?）/g, '').trim();
  if (NON_ACCOUNT_CELLS.has(cleaned)) return null;
  if (/^[-—–\s]*$/.test(cleaned)) return null; // 区切り線
  if (/^[\d,]+$/.test(cleaned)) return null;    // 金額
  if (cleaned.includes('---')) return null;
  if (cleaned.length === 0 || cleaned.length > 20) return null;
  return cleaned;
}

function extractAccounts(title: string, content: string): string[] {
  const set = new Set<string>();
  const titleMatch = /\d+-\d+\s+([^（(\[［\s]+)/.exec(title);
  if (titleMatch?.[1]) set.add(titleMatch[1]);
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // ['', 借方, 金額, 貸方, 金額, '']
    for (const acc of [normalizeAccount(cells[1]), normalizeAccount(cells[3])]) {
      if (acc) set.add(acc);
    }
  }
  return [...set];
}

function extractTaxClass(content: string): string | null {
  const m = /消費税区分[：:]\s*\*{0,2}([^（(*\n]+?)\*{0,2}\s*(?:[（(]|$)/m.exec(content);
  return m?.[1] ? m[1].trim() : null;
}

function extractTags(title: string): string[] {
  const tags: string[] = [];
  if (title.includes('個人')) tags.push('個人');
  if (title.includes('法人')) tags.push('法人');
  return tags;
}

function toChunk(s: Section, source: string): ParsedChunk {
  const page =
    s.startPage === s.endPage
      ? s.startPage
      : `${s.startPage}-${s.endPage.replace(/^p\./, '')}`;
  const content = s.bodyLines.join('\n').trim();
  return {
    source,
    page,
    title: s.title,
    content,
    accounts: extractAccounts(s.title, content),
    taxClass: extractTaxClass(content),
    tags: extractTags(s.title),
  };
}

export function chunkKnowledgeMarkdown(markdown: string, source: string): ParsedChunk[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const text = heading[1]!;
      const hasTitle = text.includes('｜');
      const pageToken = (hasTitle ? text.split('｜')[0] : text).trim();
      const title = hasTitle ? text.split('｜').slice(1).join('｜').trim() : '';

      if (hasTitle || current === null) {
        current = { startPage: pageToken, endPage: pageToken, title, bodyLines: [] };
        sections.push(current);
      } else {
        current.endPage = pageToken; // 継続ページ（次頁に続く）
      }
      continue;
    }
    if (current) current.bodyLines.push(line);
  }

  return sections
    .filter((s) => s.title && !EXCLUDE_TITLE_KEYWORDS.some((kw) => s.title.includes(kw)))
    .map((s) => toChunk(s, source));
}
```

- [ ] **Step 4: テストを走らせて pass を確認**

Run: `cd server && npx vitest run tests/services/knowledge-chunker.test.ts`
Expected: PASS（3 テスト）

- [ ] **Step 5: Commit**

```bash
git add server/src/services/knowledge-chunker.ts server/tests/services/knowledge-chunker.test.ts
git commit -m "feat(spec 26): 会計事典markdownチャンカーを追加"
```

---

## Task 4: 検索サービス knowledge-service

**Files:**
- Create: `server/src/services/knowledge-service.ts`
- Test: `server/tests/services/knowledge-service.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`server/tests/services/knowledge-service.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { prisma } from '../../src/lib/prisma.js';
import { __resetEnvCache } from '../../src/env.js';
import {
  findSimilarKnowledge,
  loadKnowledgeCache,
} from '../../src/services/knowledge-service.js';

vi.mock('openai', () => ({ default: vi.fn() }));
const MockedOpenAI = OpenAI as unknown as ReturnType<typeof vi.fn>;

describe('knowledge-service', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    __resetEnvCache();

    await prisma.knowledgeChunk.deleteMany();
    await prisma.knowledgeChunk.createMany({
      data: [
        {
          source: 'siwake-jiten',
          page: 'p.32-33',
          title: '1-01 租税公課',
          content: '税金の支払い。租税公課 / 現金。',
          accounts: ['租税公課', '現金'],
          taxClass: '対象外',
          tags: ['個人', '法人'],
          embeddingJson: JSON.stringify([1, 0]),
        },
        {
          source: 'siwake-jiten',
          page: 'p.40',
          title: '1-04 旅費交通費',
          content: '出張の交通費。旅費交通費 / 現金。',
          accounts: ['旅費交通費', '現金'],
          taxClass: '課税',
          tags: ['個人', '法人'],
          embeddingJson: JSON.stringify([0, 1]),
        },
      ],
    });

    const create = vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0] }] });
    MockedOpenAI.mockImplementation(() => ({ embeddings: { create } }));

    await loadKnowledgeCache();
  });

  afterAll(async () => {
    await prisma.knowledgeChunk.deleteMany();
    await prisma.$disconnect();
  });

  it('ranks the chunk closest to the query embedding first', async () => {
    const result = await findSimilarKnowledge('借方:租税公課 自動車税を現金で支払った', 2);
    expect(result[0]?.title).toBe('1-01 租税公課');
    expect(result[0]?.similarity).toBeGreaterThanOrEqual(result[1]?.similarity ?? 0);
  });

  it('returns empty array when no chunks exist (fallback)', async () => {
    await prisma.knowledgeChunk.deleteMany();
    await loadKnowledgeCache();
    const result = await findSimilarKnowledge('何か', 3);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: テストを走らせて fail を確認**

Run: `cd server && npx vitest run tests/services/knowledge-service.test.ts`
Expected: FAIL（`knowledge-service.js` 未解決）

- [ ] **Step 3: 実装を書く**

`server/src/services/knowledge-service.ts`:

```ts
import type { KnowledgeChunk } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { cosineSimilarity, generateEmbedding } from './journal-pattern-service.js';

export interface KnowledgeChunkResult {
  id: string;
  source: string;
  page: string;
  title: string;
  content: string;
  accounts: string[];
  taxClass: string | null;
  tags: string[];
  similarity: number;
}

let knowledgeCache: Array<{ chunk: KnowledgeChunk; embedding: number[] }> = [];

function chunkToSearchText(chunk: KnowledgeChunk): string {
  return [chunk.title, chunk.accounts.join(' '), chunk.taxClass ?? '', chunk.content]
    .filter(Boolean)
    .join(' ');
}

function keywordScore(chunk: KnowledgeChunk, queryText: string): number {
  let score = 0;
  for (const acc of chunk.accounts) if (queryText.includes(acc)) score += 2;
  for (const tag of chunk.tags) if (queryText.includes(tag)) score += 1;
  return score;
}

function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

function toResult(
  row: { chunk: KnowledgeChunk; embedding: number[] },
  similarity: number,
): KnowledgeChunkResult {
  return {
    id: row.chunk.id,
    source: row.chunk.source,
    page: row.chunk.page,
    title: row.chunk.title,
    content: row.chunk.content,
    accounts: row.chunk.accounts,
    taxClass: row.chunk.taxClass,
    tags: row.chunk.tags,
    similarity,
  };
}

export async function loadKnowledgeCache(): Promise<void> {
  const rows = await prisma.knowledgeChunk.findMany({ orderBy: { createdAt: 'asc' } });
  knowledgeCache = rows.map((chunk) => {
    let embedding: number[] = [];
    if (chunk.embeddingJson) {
      try {
        const parsed = JSON.parse(chunk.embeddingJson) as unknown;
        if (Array.isArray(parsed)) {
          embedding = parsed.filter((v): v is number => typeof v === 'number');
        }
      } catch (err) {
        logger.warn({ err, chunkId: chunk.id }, 'invalid knowledge embeddingJson');
      }
    }
    return { chunk, embedding };
  });
}

export async function findSimilarKnowledge(
  queryText: string,
  topK = 3,
): Promise<KnowledgeChunkResult[]> {
  if (knowledgeCache.length === 0) {
    await loadKnowledgeCache();
  }
  if (knowledgeCache.length === 0) return []; // 未投入フォールバック

  const queryEmbedding = await generateEmbedding(queryText);

  const semantic = knowledgeCache
    .filter((row) => row.embedding.length > 0)
    .map((row) => ({ row, sim: cosineSimilarity(row.embedding, queryEmbedding) }))
    .sort((a, b) => b.sim - a.sim);

  const keyword = knowledgeCache
    .map((row) => ({ row, score: keywordScore(row.chunk, queryText) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const rrf = new Map<string, { row: (typeof knowledgeCache)[0]; rrf: number; sim: number }>();
  semantic.forEach(({ row, sim }, rank) => {
    rrf.set(row.chunk.id, { row, rrf: rrfScore(rank), sim });
  });
  keyword.forEach(({ row }, rank) => {
    const prev = rrf.get(row.chunk.id);
    if (prev) rrf.set(row.chunk.id, { ...prev, rrf: prev.rrf + rrfScore(rank) });
    else rrf.set(row.chunk.id, { row, rrf: rrfScore(rank), sim: 0 });
  });

  return [...rrf.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK)
    .map(({ row, sim }) => toResult(row, sim));
}

export async function seedKnowledgeEmbeddings(): Promise<{ seeded: number; skipped: number }> {
  const rows = await prisma.knowledgeChunk.findMany({
    where: { OR: [{ embeddingJson: null }, { embeddingJson: '' }] },
    orderBy: { createdAt: 'asc' },
  });

  if (rows.length === 0) {
    await loadKnowledgeCache();
    return { seeded: 0, skipped: 0 };
  }

  let seeded = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const embedding = await generateEmbedding(chunkToSearchText(row));
      if (embedding.length === 0) {
        skipped += 1;
        continue;
      }
      await prisma.knowledgeChunk.update({
        where: { id: row.id },
        data: { embeddingJson: JSON.stringify(embedding) },
      });
      seeded += 1;
    } catch (err) {
      logger.warn({ err, chunkId: row.id }, 'seedKnowledgeEmbeddings failed for chunk');
      skipped += 1;
    }
  }

  await loadKnowledgeCache();
  return { seeded, skipped };
}
```

- [ ] **Step 4: テストを走らせて pass を確認**

Run: `cd server && npx vitest run tests/services/knowledge-service.test.ts`
Expected: PASS（2 テスト）

- [ ] **Step 5: Commit**

```bash
git add server/src/services/knowledge-service.ts server/tests/services/knowledge-service.test.ts
git commit -m "feat(spec 26): ナレッジ検索サービスを追加"
```

---

## Task 5: 取り込みスクリプト seed-knowledge

**Files:**
- Create: `server/scripts/seed-knowledge.ts`
- Modify: `server/package.json:16`（scripts に追記）

- [ ] **Step 1: スクリプトを書く**

`server/scripts/seed-knowledge.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '../src/lib/prisma.js';
import { chunkKnowledgeMarkdown } from '../src/services/knowledge-chunker.js';
import { seedKnowledgeEmbeddings } from '../src/services/knowledge-service.js';

const SOURCE = 'siwake-jiten';
const KNOWLEDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/data/knowledge');

async function main() {
  const files = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith('.md'));
  let created = 0;
  let updated = 0;

  for (const file of files) {
    const md = readFileSync(join(KNOWLEDGE_DIR, file), 'utf-8');
    for (const c of chunkKnowledgeMarkdown(md, SOURCE)) {
      const existing = await prisma.knowledgeChunk.findUnique({
        where: { source_title: { source: c.source, title: c.title } },
        select: { id: true },
      });
      if (existing) {
        await prisma.knowledgeChunk.update({
          where: { id: existing.id },
          data: { page: c.page, content: c.content, accounts: c.accounts, taxClass: c.taxClass, tags: c.tags },
        });
        updated += 1;
      } else {
        await prisma.knowledgeChunk.create({
          data: {
            source: c.source,
            page: c.page,
            title: c.title,
            content: c.content,
            accounts: c.accounts,
            taxClass: c.taxClass,
            tags: c.tags,
          },
        });
        created += 1;
      }
    }
  }

  const embed = await seedKnowledgeEmbeddings();
  const total = await prisma.knowledgeChunk.count();
  console.log(
    `[seed:knowledge] total=${total} created=${created} updated=${updated} embeddingsSeeded=${embed.seeded} embeddingsSkipped=${embed.skipped}`,
  );
}

main()
  .catch((err) => {
    console.error('[seed:knowledge] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 2: package.json に script 追加**

`server/package.json` の `"seed:patterns": ...,`（:16）の直後に追記:

```json
    "seed:knowledge": "tsx scripts/seed-knowledge.ts",
```

- [ ] **Step 3: dev DB に対して実行（冪等確認）**

```bash
cd /home/kkouta/busines/reiwaaccounting-gaki/server && npm run seed:knowledge
```

Expected: `[seed:knowledge] total=<N> created=<N> updated=0 embeddingsSeeded=<N> ...`（N は100前後）

- [ ] **Step 4: 再実行して冪等性を確認**

Run: `cd server && npm run seed:knowledge`
Expected: `created=0 updated=<N>`、`total` が前回と同じ（行が増えない）

- [ ] **Step 5: Commit**

```bash
git add server/scripts/seed-knowledge.ts server/package.json
git commit -m "feat(spec 26): ナレッジ取り込みスクリプトを追加"
```

---

## Task 6: journal-rag-service への注入

**Files:**
- Modify: `server/src/services/journal-rag-service.ts`
- Modify: `server/tests/services/journal-rag-service.test.ts`

- [ ] **Step 1: 既存テストに knowledge-service モックを追加し、新テストを書く（失敗確認用）**

`server/tests/services/journal-rag-service.test.ts` の上部、既存の `vi.mock('../../src/services/journal-pattern-service.js', ...)`（:11-13）の直後に追加:

```ts
vi.mock('../../src/services/knowledge-service.js', () => ({
  findSimilarKnowledge: vi.fn(),
}));
```

import 行（:5 付近）の直後に追加:

```ts
import { findSimilarKnowledge } from '../../src/services/knowledge-service.js';
const mockedFindSimilarKnowledge = findSimilarKnowledge as unknown as ReturnType<typeof vi.fn>;
```

`beforeEach`（:50-56）の `mockedFindSimilarPatterns.mockResolvedValue(basePatterns);` の直後に追加:

```ts
mockedFindSimilarKnowledge.mockResolvedValue([]);
```

ファイル末尾の `describe` 閉じ括弧の前に新テストを追加:

```ts
  it('injects knowledge section and records knowledgeUsed when chunks found', async () => {
    mockedFindSimilarKnowledge.mockResolvedValue([
      {
        id: 'k-1',
        source: 'siwake-jiten',
        page: 'p.32-33',
        title: '1-01 租税公課',
        content: '税金の支払いは租税公課で処理する。',
        accounts: ['租税公課', '現金'],
        taxClass: '対象外',
        tags: ['個人', '法人'],
        similarity: 0.88,
      },
    ]);
    const create = mockChatResponse({
      memo: '自動車税 納付',
      confidence: 0.9,
      reasoning: '事典の解説と整合',
      canJudge: true,
    });

    const result = await generateMemoWithRag({
      debit: '租税公課',
      credit: '現金',
      amount: 50000,
      date: '2026-05-29',
      originalMemo: '',
    });

    expect(result.knowledgeUsed).toEqual(['k-1']);
    const userMessage = create.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === 'user',
    )?.content as string;
    expect(userMessage).toContain('参考解説');
    expect(userMessage).toContain('1-01 租税公課');
  });

  it('omits knowledge section when no chunks found (fallback to spec23 behavior)', async () => {
    mockedFindSimilarKnowledge.mockResolvedValue([]);
    const create = mockChatResponse({
      memo: '大阪出張旅費',
      confidence: 0.9,
      reasoning: 'パターンのみで判定',
      canJudge: true,
    });

    const result = await generateMemoWithRag({
      debit: '旅費交通費',
      credit: '現金',
      amount: 18420,
      date: '2026-05-29',
      originalMemo: '',
    });

    expect(result.knowledgeUsed).toEqual([]);
    const userMessage = create.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === 'user',
    )?.content as string;
    expect(userMessage).not.toContain('参考解説');
  });
```

- [ ] **Step 2: テストを走らせて fail を確認**

Run: `cd server && npx vitest run tests/services/journal-rag-service.test.ts`
Expected: FAIL（`result.knowledgeUsed` が undefined、`参考解説` が prompt に無い）

- [ ] **Step 3: 実装を書く（journal-rag-service.ts を編集）**

(a) import 追加（`import { findSimilarPatterns } ...`（:4）の直後）:

```ts
import { findSimilarKnowledge } from './knowledge-service.js';
```

(b) `RagResult` interface（:25-32）に追加:

```ts
  /** 参考にした会計事典チャンクの id（任意） */
  knowledgeUsed?: string[];
```

(c) `buildSystemPrompt` の rules 配列（:84-89 付近）、`- 判断に必要な情報が不足している場合は canJudge: false を返す` の直後に1行追加:

```ts
    '- 参考解説（会計事典）が提示された場合は、勘定科目の選択・消費税区分・個人/法人の違いの判断根拠として活用してよい',
```

(d) `buildUserPrompt` のシグネチャ（:124-128）に `knowledgeSection` を追加し、`return` 配列（:144-158）の patternSection 行の直後に挿入:

```ts
function buildUserPrompt(
  input: RagInput,
  patternSection: string,
  historySection: string,
  knowledgeSection: string,
): string {
```

return 配列内、`` `【参考パターン（類似仕訳の実例）】\n${patternSection || '該当なし'}\n` `` の直後に追加:

```ts
    knowledgeSection ? `【参考解説（会計事典）】\n${knowledgeSection}\n` : '',
```

(e) `generateMemoWithRag` 内、OPENAI_API_KEY 未設定の早期 return（:222-231）の `patternsUsed,` の行の直後に `knowledgeUsed: [],` を追加:

```ts
      routing: 'difficult',
      patternsUsed,
      knowledgeUsed: [],
    };
  }
```

(f) 上記 return ブロックの閉じ `}` の直後（patternSection 構築の前、:233 付近）に knowledge 取得を追加:

```ts
  const knowledge = await findSimilarKnowledge(queryText, 3);
  const knowledgeUsed = knowledge.map((k) => k.id);
  const knowledgeSection = knowledge
    .map((k, i) => `${i + 1}. ${k.title}\n${k.content}`)
    .join('\n\n');
```

(g) OpenAI 呼び出しの `buildUserPrompt(input, patternSection, historySection)`（:262）を差し替え:

```ts
        { role: 'user', content: buildUserPrompt(input, patternSection, historySection, knowledgeSection) },
```

(h) 成功時の return（:283-290）に `knowledgeUsed,` を追加:

```ts
      routing,
      patternsUsed,
      knowledgeUsed,
    };
```

(i) catch ブロックの return（:293-300）に `knowledgeUsed,` を追加（この時点で `knowledgeUsed` は scope 内）:

```ts
      routing: 'difficult',
      patternsUsed,
      knowledgeUsed,
    };
```

- [ ] **Step 4: テストを走らせて pass を確認**

Run: `cd server && npx vitest run tests/services/journal-rag-service.test.ts`
Expected: PASS（既存 8 ＋ 新規 2 = 10 テスト）

- [ ] **Step 5: Commit**

```bash
git add server/src/services/journal-rag-service.ts server/tests/services/journal-rag-service.test.ts
git commit -m "feat(spec 26): RAG生成プロンプトに会計事典解説を注入"
```

---

## Task 7: 全体検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 全テストを走らせる**

Run: `cd /home/kkouta/busines/reiwaaccounting-gaki/server && npm test`
Expected: 全 green（既存テスト含む。`knowledge-chunker` / `knowledge-service` / `journal-rag-service` を含む）

- [ ] **Step 2: 型チェック（新規エラーが無いこと）**

Run: `cd server && npx tsc --noEmit`
Expected: 既知の pre-existing エラー（`mode.ts:44`, `server.ts:25`, `server.ts:63`）のみ。新規ファイル由来のエラーが出ないこと

- [ ] **Step 3: 取り込み済みデータの妥当性を目視確認**

Run: `cd server && npx prisma studio`（または psql）で `KnowledgeChunk` を確認
Expected: 租税公課など科目セクションが入り、`accounts` / `taxClass` / `embeddingJson` が埋まっている。前付け・索引が入っていない

- [ ] **Step 4: 受入基準の最終チェック（spec 26 の受入基準 1〜7）**

spec の受入基準を1つずつ確認し、未達があれば該当 Task に戻る。

---

## Self-Review（プラン作成者による確認）

**Spec coverage:**
- データソース repo コピー → Task 1 ✓
- KnowledgeChunk モデル＋マイグレーション → Task 2 ✓
- チャンク分割（純粋関数・継続結合・前付け除外・メタ抽出）→ Task 3 ✓
- 検索サービス（cosine 主体＋keyword 補助 RRF・seed embedding）→ Task 4 ✓
- 取り込みスクリプト＋npm script・冪等 → Task 5 ✓
- 生成への注入（findSimilarKnowledge・【参考解説】節・system prompt 一文・knowledgeUsed）→ Task 6 ✓
- フォールバック（未投入で空配列・spec23 挙動）→ Task 4 Step1 第2テスト＋Task 6 Step1 第2テスト ✓
- 全テスト green・新規 tsc エラー無し → Task 7 ✓

**Type consistency:** `ParsedChunk`(chunker) → `KnowledgeChunk`(prisma) → `KnowledgeChunkResult`(service) のフィールド名（source/page/title/content/accounts/taxClass/tags）が一貫。`findSimilarKnowledge(queryText, topK)` のシグネチャが service 定義・rag 呼び出し・テストモックで一致。`knowledgeUsed?` はオプショナルで全 return をカバー。

**Placeholder scan:** 全ステップに実コード・実コマンド・期待値あり。プレースホルダ無し。
