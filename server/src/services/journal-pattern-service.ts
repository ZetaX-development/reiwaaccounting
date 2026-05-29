import OpenAI from 'openai';
import type { JournalPattern as JournalPatternRow } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

export interface JournalPatternWithSimilarity {
  id: string;
  debit: string;
  credit: string;
  scenario: string;
  memoExamples: string[];
  industry: string | null;
  tags: string[];
  similarity: number;
}

// メモリキャッシュ（モジュールスコープ）
let patternCache: Array<{ pattern: JournalPatternRow; embedding: number[] }> = [];

// ---------------------------------------------------------------------------
// コサイン類似度（純粋関数）
// ---------------------------------------------------------------------------
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Embedding 生成（OpenAI text-embedding-3-small）
// ---------------------------------------------------------------------------
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!env.OPENAI_API_KEY) return [];
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  return Array.isArray(embedding) ? embedding : [];
}

// ---------------------------------------------------------------------------
// パターンをテキスト化（embedding の入力）
// ---------------------------------------------------------------------------
function patternToSearchText(pattern: JournalPatternRow): string {
  return [
    `借方:${pattern.debit}`,
    `貸方:${pattern.credit}`,
    `シナリオ:${pattern.scenario}`,
    `摘要例:${pattern.memoExamples.join(' / ')}`,
    `タグ:${pattern.tags.join(',')}`,
    pattern.industry ? `業種:${pattern.industry}` : '',
    pattern.amountHint ? `金額ヒント:${pattern.amountHint}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// DBから全件ロードしてメモリキャッシュ
// ---------------------------------------------------------------------------
export async function loadPatternsCache(): Promise<void> {
  const rows = await prisma.journalPattern.findMany({ orderBy: { createdAt: 'asc' } });
  patternCache = rows.map((pattern) => {
    let embedding: number[] = [];
    if (pattern.embeddingJson) {
      try {
        const parsed = JSON.parse(pattern.embeddingJson) as unknown;
        if (Array.isArray(parsed)) {
          embedding = parsed.filter((v): v is number => typeof v === 'number');
        }
      } catch (err) {
        logger.warn({ err, patternId: pattern.id }, 'invalid journal pattern embeddingJson');
      }
    }
    return { pattern, embedding };
  });
}

// ---------------------------------------------------------------------------
// タグ・キーワードマッチスコア（RRF補完用）
// ---------------------------------------------------------------------------
function tagMatchScore(pattern: JournalPatternRow, queryText: string): number {
  const q = queryText.toLowerCase();
  let score = 0;
  for (const tag of pattern.tags) {
    if (q.includes(tag.toLowerCase())) score += 1;
  }
  if (q.includes(pattern.debit)) score += 2;
  if (q.includes(pattern.credit)) score += 2;
  return score;
}

function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

// ---------------------------------------------------------------------------
// toResult ヘルパー
// ---------------------------------------------------------------------------
function toResult(
  row: { pattern: JournalPatternRow; embedding: number[] },
  queryEmbedding: number[],
  precomputedSim?: number,
): JournalPatternWithSimilarity {
  const similarity = precomputedSim ?? cosineSimilarity(row.embedding, queryEmbedding);
  return {
    id: row.pattern.id,
    debit: row.pattern.debit,
    credit: row.pattern.credit,
    scenario: row.pattern.scenario,
    memoExamples: row.pattern.memoExamples,
    industry: row.pattern.industry,
    tags: row.pattern.tags,
    similarity,
  };
}

// ---------------------------------------------------------------------------
// 類似パターン検索（勘定科目完全一致優先 + セマンティック + タグ RRF）
// ---------------------------------------------------------------------------
export async function findSimilarPatterns(
  debit: string,
  credit: string,
  queryText: string,
  topK: number = 5,
): Promise<JournalPatternWithSimilarity[]> {
  if (patternCache.length === 0) {
    await loadPatternsCache();
  }

  const queryEmbedding = await generateEmbedding(queryText);

  // 1. 勘定科目完全一致（最優先）
  const exactMatches = patternCache
    .filter((row) => row.pattern.debit === debit && row.pattern.credit === credit)
    .map((row) => ({ row, sim: cosineSimilarity(row.embedding, queryEmbedding) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3);

  // 2. セマンティック類似度ランキング
  const semanticRanked = patternCache
    .filter((row) => row.embedding.length > 0)
    .map((row) => ({ row, sim: cosineSimilarity(row.embedding, queryEmbedding) }))
    .sort((a, b) => b.sim - a.sim);

  // 3. タグキーワードマッチランキング
  const tagRanked = [...patternCache]
    .map((row) => ({ row, score: tagMatchScore(row.pattern, queryText) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // 4. RRF融合
  const rrfMap = new Map<string, { row: (typeof patternCache)[0]; rrf: number; sim: number }>();
  semanticRanked.forEach(({ row, sim }, rank) => {
    const prev = rrfMap.get(row.pattern.id);
    rrfMap.set(row.pattern.id, { row, rrf: (prev?.rrf ?? 0) + rrfScore(rank), sim });
  });
  tagRanked.forEach(({ row }, rank) => {
    const prev = rrfMap.get(row.pattern.id);
    if (prev) rrfMap.set(row.pattern.id, { ...prev, rrf: prev.rrf + rrfScore(rank) });
  });
  const rrfRanked = [...rrfMap.values()].sort((a, b) => b.rrf - a.rrf).slice(0, 7);

  // 5. 完全一致を先頭、RRFで補完
  const merged: JournalPatternWithSimilarity[] = [];
  const seen = new Set<string>();

  for (const { row, sim } of exactMatches) {
    if (seen.has(row.pattern.id)) continue;
    seen.add(row.pattern.id);
    merged.push(toResult(row, queryEmbedding, sim));
    if (merged.length >= topK) break;
  }
  for (const { row, sim } of rrfRanked) {
    if (seen.has(row.pattern.id)) continue;
    seen.add(row.pattern.id);
    merged.push(toResult(row, queryEmbedding, sim));
    if (merged.length >= topK) break;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// 全パターンのembeddingを生成してDBに保存
// ---------------------------------------------------------------------------
export async function seedEmbeddings(): Promise<{ seeded: number; skipped: number }> {
  const rows = await prisma.journalPattern.findMany({
    where: { OR: [{ embeddingJson: null }, { embeddingJson: '' }] },
    orderBy: { createdAt: 'asc' },
  });

  if (rows.length === 0) {
    await loadPatternsCache();
    return { seeded: 0, skipped: 0 };
  }

  let seeded = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const embedding = await generateEmbedding(patternToSearchText(row));
      if (embedding.length === 0) {
        skipped += 1;
        continue;
      }
      await prisma.journalPattern.update({
        where: { id: row.id },
        data: { embeddingJson: JSON.stringify(embedding) },
      });
      seeded += 1;
    } catch (err) {
      logger.warn({ err, patternId: row.id }, 'seedEmbeddings failed for pattern');
      skipped += 1;
    }
  }

  await loadPatternsCache();
  return { seeded, skipped };
}
