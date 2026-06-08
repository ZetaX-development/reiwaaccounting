import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import OpenAI from 'openai';
import { prisma } from '../../src/lib/prisma.js';
import { generateDraftJournal } from '../../src/services/journal-draft-service.js';
import { __resetEnvCache } from '../../src/env.js';

vi.mock('openai', () => ({
  default: vi.fn(),
}));

const MockedOpenAI = OpenAI as unknown as ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_VISION_MODEL = 'gpt-5';
  __resetEnvCache();
  await prisma.voucher.deleteMany();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.$disconnect();
});

async function createVoucherFixture(
  ocrJson: unknown,
  matchStatus = 'unmatched',
): Promise<string> {
  const v = await prisma.voucher.create({
    data: {
      firmId: 'demo-firm',
      clientId: 'aoyama-design',
      filename: 'sample.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      imageData: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      ocrStatus: 'done',
      ocrJson: ocrJson as never,
      matchStatus,
    },
  });
  return v.id;
}

describe('generateDraftJournal', () => {
  it('auto-classifies (approved) when unmatched and no missing fields', async () => {
    const id = await createVoucherFixture({
      issue_date: '2026-05-15',
      vendor_name: 'ハラペコステーキ',
      addressee: '青山デザイン株式会社',
      amount: 12000,
      invoice_number: 'T1234567890123',
    });

    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              transactionDate: '2026-05-15',
              debit: {
                account: '接待交際費',
                subAccount: null,
                partner: 'ハラペコステーキ',
                taxClass: '課税仕入10%',
                invoiceNumber: 'T1234567890123',
                amount: 12000,
              },
              credit: {
                account: '現金',
                subAccount: null,
                partner: null,
                taxClass: '対象外',
                invoiceNumber: null,
                amount: 12000,
              },
              description: 'ハラペコステーキ — 取引先との会食',
              missingFields: [],
              reasoning: '請求書の宛名と業種から会食と判断',
            }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    await generateDraftJournal(id);

    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.journalStatus).toBe('approved');
    expect(row?.draftJournalJson).toMatchObject({
      transactionDate: '2026-05-15',
      debit: { account: '接待交際費', amount: 12000 },
      credit: { account: '現金', amount: 12000 },
      description: 'ハラペコステーキ — 取引先との会食',
      missingFields: [],
      autoClassified: true,
    });

    expect(create).toHaveBeenCalledOnce();
    const callArg = create.mock.calls[0][0];
    expect(callArg.model).toBe('gpt-5');
  });

  it('keeps drafted (no auto-classify) when matchStatus is matched', async () => {
    const id = await createVoucherFixture(
      {
        issue_date: '2026-05-15',
        vendor_name: 'ハラペコステーキ',
        addressee: '青山デザイン株式会社',
        amount: 12000,
        invoice_number: 'T1234567890123',
      },
      'matched',
    );

    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              transactionDate: '2026-05-15',
              debit: {
                account: '接待交際費',
                subAccount: null,
                partner: 'ハラペコステーキ',
                taxClass: '課税仕入10%',
                invoiceNumber: null,
                amount: 12000,
              },
              credit: {
                account: '現金',
                subAccount: null,
                partner: null,
                taxClass: '対象外',
                invoiceNumber: null,
                amount: 12000,
              },
              description: '会食',
              missingFields: [],
              reasoning: 'x',
            }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    await generateDraftJournal(id);

    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.journalStatus).toBe('drafted');
    expect(
      (row?.draftJournalJson as { autoClassified?: boolean })?.autoClassified,
    ).toBeUndefined();
  });

  it('marks journalStatus needs_info when missingFields are returned', async () => {
    const id = await createVoucherFixture({
      issue_date: '2026-05-15',
      vendor_name: 'ハラペコステーキ',
      addressee: null,
      amount: 8000,
      invoice_number: null,
    });

    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              transactionDate: '2026-05-15',
              debit: {
                account: '接待交際費',
                subAccount: null,
                partner: 'ハラペコステーキ',
                taxClass: '課税仕入10%',
                invoiceNumber: null,
                amount: 8000,
              },
              credit: {
                account: '現金',
                subAccount: null,
                partner: null,
                taxClass: '対象外',
                invoiceNumber: null,
                amount: 8000,
              },
              description: 'ハラペコステーキ — 会食 (要確認)',
              missingFields: ['参加者'],
              reasoning: '宛名なし',
            }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    await generateDraftJournal(id);

    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.journalStatus).toBe('needs_info');
    expect(
      (row?.draftJournalJson as { missingFields: string[] }).missingFields,
    ).toEqual(['参加者']);
  });

  it('includes lineAnswers as 追加情報 in the user message when present', async () => {
    const v = await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: 'aoyama-design',
        filename: 'sample2.jpg',
        mimeType: 'image/jpeg',
        size: 4,
        imageData: Buffer.from([0x00, 0x01, 0x02, 0x03]),
        ocrStatus: 'done',
        ocrJson: { issue_date: '2026-05-15', vendor_name: 'テスト食堂', addressee: null, amount: 5000, invoice_number: null } as never,
        matchStatus: 'unmatched',
        lineAnswers: { 会食の参加者: '田中部長、鈴木様' } as never,
      },
    });

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        transactionDate: '2026-05-15',
        debit: { account: '接待交際費', subAccount: null, partner: 'テスト食堂', taxClass: '課税仕入10%', invoiceNumber: null, amount: 5000 },
        credit: { account: '現金', subAccount: null, partner: null, taxClass: '対象外', invoiceNumber: null, amount: 5000 },
        description: 'テスト食堂 — 会食 田中部長、鈴木様',
        missingFields: [],
        reasoning: '追加情報から参加者を確認',
      }) } }],
    });
    MockedOpenAI.mockImplementation(() => ({ chat: { completions: { create } } }));

    await generateDraftJournal(v.id);

    const callArg = create.mock.calls[0][0];
    const userMsg = callArg.messages.find((m: { role: string }) => m.role === 'user')?.content as string;
    expect(userMsg).toContain('田中部長');
    expect(userMsg).toContain('会食の参加者');
  });

  it('skips OpenAI and stays at journalStatus none when ocr amount is missing', async () => {
    const id = await createVoucherFixture({
      issue_date: '2026-05-15',
      vendor_name: 'ハラペコステーキ',
      addressee: null,
      amount: null,
      invoice_number: null,
    });

    const create = vi.fn();
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    await generateDraftJournal(id);

    expect(create).not.toHaveBeenCalled();
    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.journalStatus).toBe('none');
    expect(row?.draftJournalJson).toBeNull();
  });
});
