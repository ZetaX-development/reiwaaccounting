import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, mfApiAdapterMock, updateJournalMemoMock, generateMemoWithRagMock } = vi.hoisted(() => ({
  prismaMock: {
    client: { findUnique: vi.fn() },
    journalAiReview: { findMany: vi.fn(), create: vi.fn() },
    todo: { create: vi.fn() },
  },
  mfApiAdapterMock: { fetchEntries: vi.fn() },
  updateJournalMemoMock: vi.fn(),
  generateMemoWithRagMock: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../../src/adapters/mf-api.js', () => ({
  mfApiAdapter: mfApiAdapterMock,
  updateJournalMemo: updateJournalMemoMock,
}));
vi.mock('../../src/services/journal-rag-service.js', () => ({
  generateMemoWithRag: generateMemoWithRagMock,
}));

import { processBlankMemoJournals } from '../../src/services/journal-ai-review-service.js';

describe('processBlankMemoJournals', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.client.findUnique.mockResolvedValue({
      mfAccessToken: 'token',
      mfExternalId: 'office-1',
    });

    prismaMock.journalAiReview.findMany.mockResolvedValue([]);

    mfApiAdapterMock.fetchEntries.mockResolvedValue({
      items: [
        {
          raw: {
            id: 'mf-journal-1',
            transaction_date: '2026-05-29',
            memo: '',
            branches: [
              {
                debitor: { account_name: '旅費交通費', value: 18420 },
                creditor: { account_name: '現金', value: 18420 },
              },
            ],
          },
        },
      ],
    });

    generateMemoWithRagMock.mockResolvedValue({
      memo: '判断保留',
      confidence: 0.42,
      reasoning: '証憑情報が不足しており判断不能',
      canJudge: false,
      routing: 'difficult',
      patternsUsed: ['p-1'],
    });
  });

  it('creates a Todo when routing is difficult', async () => {
    const result = await processBlankMemoJournals('client-1', 'firm-1', { localOnly: false });

    expect(result).toEqual({
      total: 1,
      autoApplied: 0,
      pending: 0,
      difficult: 1,
      errors: 0,
    });

    expect(prismaMock.journalAiReview.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.journalAiReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'difficult',
          mfJournalId: 'mf-journal-1',
          aiMemo: '判断保留',
        }),
      }),
    );

    expect(prismaMock.todo.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.todo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firmId: 'firm-1',
          clientId: 'client-1',
          title: 'AI判断困難: 旅費交通費 / 現金 ¥18,420',
        }),
      }),
    );

    expect(updateJournalMemoMock).not.toHaveBeenCalled();
  });
});
