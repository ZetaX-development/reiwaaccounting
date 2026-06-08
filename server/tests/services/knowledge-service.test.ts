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
