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
