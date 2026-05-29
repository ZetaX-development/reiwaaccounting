import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { prisma } from '../../src/lib/prisma.js';
import { __resetEnvCache } from '../../src/env.js';
import { cosineSimilarity, findSimilarPatterns, loadPatternsCache } from '../../src/services/journal-pattern-service.js';

vi.mock('openai', () => ({
  default: vi.fn(),
}));

const MockedOpenAI = OpenAI as unknown as ReturnType<typeof vi.fn>;

describe('journal-pattern-service', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    __resetEnvCache();

    await prisma.journalPattern.deleteMany();
    await prisma.journalPattern.createMany({
      data: [
        {
          debit: '旅費交通費',
          credit: '現金',
          scenario: '新幹線代の現金精算',
          memoExamples: ['東京大阪間 出張旅費', '新幹線代 大阪出張', 'タクシー代 得意先訪問', '出張旅費 精算', 'JR代 出張'],
          industry: null,
          tags: ['旅費', '交通費'],
          embeddingJson: JSON.stringify([1, 0]),
        },
        {
          debit: '旅費交通費',
          credit: '現金',
          scenario: '宿泊費の現金精算',
          memoExamples: ['出張宿泊費 精算', 'ホテル代 東京出張', '宿泊費 立替精算', '大阪出張 宿泊費', '宿泊費 交通費'],
          industry: null,
          tags: ['旅費', '宿泊'],
          embeddingJson: JSON.stringify([0.9, 0.1]),
        },
        {
          debit: '旅費交通費',
          credit: '現金',
          scenario: '日当の現金支給',
          memoExamples: ['出張日当 支給', '営業出張 日当', '現金日当 精算', '日当 立替精算', '出張日当 月次'],
          industry: null,
          tags: ['旅費', '日当'],
          embeddingJson: JSON.stringify([0.8, 0.2]),
        },
        {
          debit: '通信費',
          credit: '普通預金',
          scenario: 'インターネット利用料',
          memoExamples: ['ネット回線 利用料', 'プロバイダ費 通信費', 'インターネット代 月次', '回線費 振込支払', '通信費 口座振替'],
          industry: null,
          tags: ['通信費'],
          embeddingJson: JSON.stringify([0.95, 0.05]),
        },
      ],
    });

    const create = vi.fn().mockResolvedValue({
      data: [{ embedding: [1, 0] }],
    });
    MockedOpenAI.mockImplementation(() => ({
      embeddings: { create },
    }));

    await loadPatternsCache();
  });

  afterAll(async () => {
    await prisma.journalPattern.deleteMany();
    await prisma.$disconnect();
  });

  it('cosineSimilarity returns 1.0 for identical vectors and 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('findSimilarPatterns prioritizes exact debit/credit matches', async () => {
    const result = await findSimilarPatterns('旅費交通費', '現金', '借方:旅費交通費 貸方:現金 出張精算', 4);

    expect(result).toHaveLength(4);
    expect(result[0]?.debit).toBe('旅費交通費');
    expect(result[0]?.credit).toBe('現金');
    expect(result[1]?.debit).toBe('旅費交通費');
    expect(result[1]?.credit).toBe('現金');
    expect(result[2]?.debit).toBe('旅費交通費');
    expect(result[2]?.credit).toBe('現金');
    expect(result[3]?.scenario).toBe('インターネット利用料');
    expect(result[0]?.similarity).toBeGreaterThanOrEqual(result[3]?.similarity ?? 0);
  });
});
