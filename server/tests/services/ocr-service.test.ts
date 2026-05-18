import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { extractVoucherFields } from '../../src/services/ocr-service.js';
import { __resetEnvCache } from '../../src/env.js';

vi.mock('openai', () => ({
  default: vi.fn(),
}));

const MockedOpenAI = OpenAI as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_VISION_MODEL = 'gpt-5';
  __resetEnvCache();
});

describe('extractVoucherFields', () => {
  it('parses a valid OpenAI response into ExtractedFields', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              issue_date: '2026-05-15',
              vendor_name: '青山デザイン',
              addressee: '株式会社サンプル',
              amount: 3200,
              invoice_number: 'T1234567890123',
            }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    const result = await extractVoucherFields(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      'image/jpeg',
    );
    expect(result.issue_date).toBe('2026-05-15');
    expect(result.vendor_name).toBe('青山デザイン');
    expect(result.addressee).toBe('株式会社サンプル');
    expect(result.amount).toBe(3200);
    expect(result.invoice_number).toBe('T1234567890123');

    // Verify the image was passed as data URL
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0][0];
    expect(call.model).toBe('gpt-5');
    const imagePart = call.messages
      .flatMap((m: { content: unknown }) =>
        Array.isArray(m.content) ? m.content : [],
      )
      .find((p: { type: string }) => p.type === 'image_url');
    expect(imagePart.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('returns nulls for unreadable fields', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              issue_date: null,
              vendor_name: null,
              addressee: null,
              amount: null,
              invoice_number: null,
            }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    const result = await extractVoucherFields(
      Buffer.from([0x89, 0x50]),
      'image/png',
    );
    expect(result).toEqual({
      issue_date: null,
      vendor_name: null,
      addressee: null,
      amount: null,
      invoice_number: null,
    });
  });

  it('throws when OpenAI returns malformed JSON', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    });
    MockedOpenAI.mockImplementation(() => ({
      chat: { completions: { create } },
    }));

    await expect(
      extractVoucherFields(Buffer.from([0xff]), 'image/jpeg'),
    ).rejects.toThrow();
  });
});
