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

async function createVoucherFixture(ocrJson: unknown): Promise<string> {
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
      matchStatus: 'unmatched',
    },
  });
  return v.id;
}

describe('generateDraftJournal', () => {
  it('persists a drafted journal when OpenAI returns no missing fields', async () => {
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
    expect(row?.journalStatus).toBe('drafted');
    expect(row?.draftJournalJson).toMatchObject({
      transactionDate: '2026-05-15',
      debit: { account: '接待交際費', amount: 12000 },
      credit: { account: '現金', amount: 12000 },
      description: 'ハラペコステーキ — 取引先との会食',
      missingFields: [],
    });

    expect(create).toHaveBeenCalledOnce();
    const callArg = create.mock.calls[0][0];
    expect(callArg.model).toBe('gpt-5');
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
