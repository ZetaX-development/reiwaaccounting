import { beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { __resetEnvCache } from '../../src/env.js';
import { generateMemoWithRag } from '../../src/services/journal-rag-service.js';
import { findSimilarPatterns } from '../../src/services/journal-pattern-service.js';
import { findSimilarKnowledge } from '../../src/services/knowledge-service.js';

vi.mock('openai', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/services/journal-pattern-service.js', () => ({
  findSimilarPatterns: vi.fn(),
}));

vi.mock('../../src/services/knowledge-service.js', () => ({
  findSimilarKnowledge: vi.fn(),
}));

const MockedOpenAI = OpenAI as unknown as ReturnType<typeof vi.fn>;
const mockedFindSimilarPatterns = findSimilarPatterns as unknown as ReturnType<typeof vi.fn>;
const mockedFindSimilarKnowledge = findSimilarKnowledge as unknown as ReturnType<typeof vi.fn>;

const basePatterns = [
  {
    id: 'p-1',
    debit: '旅費交通費',
    credit: '現金',
    scenario: '新幹線代の現金精算',
    memoExamples: ['東京大阪間 出張旅費', '新幹線代 大阪出張', 'タクシー代 得意先訪問', '出張旅費 精算', 'JR代 出張'],
    industry: null,
    tags: ['旅費', '交通費'],
    similarity: 0.93,
  },
];

function mockChatResponse(payload: { memo: string; confidence: number; reasoning: string; canJudge: boolean }) {
  const create = vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify(payload),
        },
      },
    ],
  });

  MockedOpenAI.mockImplementation(() => ({
    chat: { completions: { create } },
  }));

  return create;
}

describe('generateMemoWithRag', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    __resetEnvCache();
    mockedFindSimilarPatterns.mockResolvedValue(basePatterns);
    mockedFindSimilarKnowledge.mockResolvedValue([]);
  });

  it('returns auto_applied when confidence=0.9 and canJudge=true', async () => {
    const create = mockChatResponse({
      memo: '大阪出張旅費',
      confidence: 0.9,
      reasoning: '過去の旅費摘要と整合',
      canJudge: true,
    });

    const result = await generateMemoWithRag({
      debit: '旅費交通費',
      credit: '現金',
      amount: 18420,
      date: '2026-05-29',
      originalMemo: '',
    });

    expect(result.routing).toBe('auto_applied');
    expect(result.memo).toBe('大阪出張旅費');
    expect(result.patternsUsed).toEqual(['p-1']);

    const requestArg = create.mock.calls[0][0];
    expect(requestArg.model).toBe('gpt-4o');
    expect(requestArg.response_format).toEqual({ type: 'json_object' });
    const userMessage = requestArg.messages.find((m: { role: string }) => m.role === 'user')?.content as string;
    expect(userMessage).toContain('新幹線代の現金精算');
    expect(userMessage).toContain('借方: 旅費交通費');
  });

  it('returns difficult when confidence=0.5', async () => {
    mockChatResponse({
      memo: '摘要要確認',
      confidence: 0.5,
      reasoning: '情報不足',
      canJudge: true,
    });

    const result = await generateMemoWithRag({
      debit: '旅費交通費',
      credit: '現金',
      amount: 12000,
      date: '2026-05-29',
      originalMemo: '出張',
    });

    expect(result.routing).toBe('difficult');
    expect(result.confidence).toBe(0.5);
  });

  it('returns difficult when canJudge=false regardless of confidence', async () => {
    mockChatResponse({
      memo: 'A社向け業務',
      confidence: 0.95,
      reasoning: '科目のみでは特定不可',
      canJudge: false,
    });

    const result = await generateMemoWithRag({
      debit: '仮払金',
      credit: '普通預金',
      amount: 500000,
      date: '2026-05-29',
      originalMemo: '',
    });

    expect(result.routing).toBe('difficult');
    expect(result.canJudge).toBe(false);
  });

  it('applies quality penalty when memo is same as debit account name', async () => {
    mockChatResponse({
      memo: '旅費交通費', // 借方科目名そのまま → penalty=0.25
      confidence: 0.88,
      reasoning: '科目名で返答',
      canJudge: true,
    });

    const result = await generateMemoWithRag({
      debit: '旅費交通費',
      credit: '現金',
      amount: 5000,
      date: '2026-05-29',
      originalMemo: '',
    });

    // 0.88 - 0.25 = 0.63 → pending (>= 0.60, < 0.85)
    expect(result.confidence).toBeCloseTo(0.63);
    expect(result.routing).toBe('pending');
  });

  it('applies large amount confidence penalty for amounts >= 1,000,000', async () => {
    mockChatResponse({
      memo: '設備投資 建物改装',
      confidence: 0.88,
      reasoning: '建物取得の典型的な仕訳',
      canJudge: true,
    });

    const result = await generateMemoWithRag({
      debit: '建物',
      credit: '普通預金',
      amount: 5_000_000, // 500万 >= 100万
      date: '2026-05-29',
      originalMemo: '',
    });

    // 0.88 - 0.12(大口ペナルティ) = 0.76 → pending
    expect(result.confidence).toBeCloseTo(0.76);
    expect(result.routing).toBe('pending');
  });

  it('includes client history in the prompt when provided', async () => {
    const create = mockChatResponse({
      memo: 'A社 売上計上',
      confidence: 0.9,
      reasoning: '顧客履歴と合致',
      canJudge: true,
    });

    await generateMemoWithRag({
      debit: '売掛金',
      credit: '売上高',
      amount: 100000,
      date: '2026-05-29',
      originalMemo: '',
      clientHistory: [
        { debit: '売掛金', credit: '売上高', amount: 90000, memo: 'A社 月次売上' },
      ],
    });

    const userMessage = create.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === 'user',
    )?.content as string;
    expect(userMessage).toContain('承認済み摘要履歴');
    expect(userMessage).toContain('A社 月次売上');
  });

  it('includes industry context in system prompt when provided', async () => {
    const create = mockChatResponse({
      memo: '建設現場 材料仕入',
      confidence: 0.87,
      reasoning: '建設業の仕入パターン',
      canJudge: true,
    });

    await generateMemoWithRag({
      debit: '仕入高',
      credit: '買掛金',
      amount: 300000,
      date: '2026-05-29',
      originalMemo: '',
      clientIndustry: '建設業',
    });

    const systemMessage = create.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === 'system',
    )?.content as string;
    expect(systemMessage).toContain('建設業');
  });

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

  it('returns difficult without API key', async () => {
    delete process.env.OPENAI_API_KEY;
    __resetEnvCache();

    const result = await generateMemoWithRag({
      debit: '給料手当',
      credit: '普通預金',
      amount: 300000,
      date: '2026-05-29',
      originalMemo: '',
    });

    expect(result.routing).toBe('difficult');
    expect(result.canJudge).toBe(false);
  });
});
