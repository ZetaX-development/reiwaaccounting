import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import OpenAI from 'openai';
import { prisma } from '../../src/lib/prisma.js';
import { createVoucher } from '../../src/services/voucher-service.js';
import { assignVoucherToClient } from '../../src/services/voucher-assign-service.js';
import { __resetEnvCache } from '../../src/env.js';

vi.mock('openai', () => ({
  default: vi.fn(),
}));

const MockedOpenAI = OpenAI as unknown as ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_VISION_MODEL = 'gpt-5';
  __resetEnvCache();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.$disconnect();
});

async function makeVoucher(ocrJson: unknown) {
  const meta = await createVoucher({
    clientId: null,
    filename: 't.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff]),
    uploadedBy: null,
  });
  await prisma.voucher.update({
    where: { id: meta.id },
    data: { ocrJson: ocrJson as any, ocrStatus: 'done' },
  });
  return meta.id;
}

describe('assignVoucherToClient', () => {
  it('matches by addressee substring (seeded client)', async () => {
    // Seed has client { id: 'shibuya-cafe', name: '渋谷カフェ合同会社' }.
    // The voucher addressee "渋谷カフェ" is a substring of the client name.
    const id = await makeVoucher({
      vendor_name: 'カフェXYZ',
      addressee: '渋谷カフェ',
      amount: 1000,
      issue_date: '2026-05-15',
      invoice_number: null,
    });
    const result = await assignVoucherToClient(id);
    expect(result).toEqual({ clientId: 'shibuya-cafe', reason: 'addressee' });
    expect(MockedOpenAI).not.toHaveBeenCalled();
  });

  it('falls back to AI and returns clientId when addressee does not match', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ clientId: 'aoyama-design' }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    const id = await makeVoucher({
      vendor_name: 'カフェXYZ',
      addressee: '様',
      amount: 1000,
      issue_date: '2026-05-15',
      invoice_number: null,
    });
    const result = await assignVoucherToClient(id);
    expect(result).toEqual({ clientId: 'aoyama-design', reason: 'ai' });
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0][0];
    expect(call.model).toBe('gpt-5');
  });

  it('returns ai_uncertain when AI returns null', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: { content: JSON.stringify({ clientId: null }) },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    const id = await makeVoucher({
      vendor_name: 'カフェXYZ',
      addressee: '様',
      amount: 1000,
      issue_date: '2026-05-15',
      invoice_number: null,
    });
    const result = await assignVoucherToClient(id);
    expect(result).toEqual({ clientId: null, reason: 'ai_uncertain' });
  });

  it('returns ai_uncertain when AI returns clientId not in client list', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: { content: JSON.stringify({ clientId: 'bogus-id' }) },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    const id = await makeVoucher({
      vendor_name: 'カフェXYZ',
      addressee: '様',
      amount: 1000,
      issue_date: '2026-05-15',
      invoice_number: null,
    });
    const result = await assignVoucherToClient(id);
    expect(result).toEqual({ clientId: null, reason: 'ai_uncertain' });
  });

  it('returns no_data when voucher has no ocrJson', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 't.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff]),
      uploadedBy: null,
    });
    const result = await assignVoucherToClient(meta.id);
    expect(result).toEqual({ clientId: null, reason: 'no_data' });
  });

  it('returns no_api_key when OPENAI_API_KEY is empty and no addressee hit', async () => {
    process.env.OPENAI_API_KEY = '';
    __resetEnvCache();
    const id = await makeVoucher({
      vendor_name: 'カフェXYZ',
      addressee: '様',
      amount: 1000,
      issue_date: '2026-05-15',
      invoice_number: null,
    });
    const result = await assignVoucherToClient(id);
    expect(result).toEqual({ clientId: null, reason: 'no_api_key' });
    expect(MockedOpenAI).not.toHaveBeenCalled();
  });
});
