import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { generateReminderDraft } from '../../src/services/reminder-draft-service.js';

// OpenAI is an auxiliary service — mock it
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    subject: '[経理丸ごとAI] 5月分 証憑のご提出をお願いいたします',
                    body: '青山デザイン 様\n\nお世話になっております。\n5月分の証憑（領収書・請求書等）がまだ届いておりません。\nご確認のほどよろしくお願いいたします。\n\n担当: テスト担当者',
                  }),
                },
              },
            ],
          }),
        },
      },
    })),
  };
});

beforeEach(async () => {
  await prisma.voucher.deleteMany({ where: { clientId: 'aoyama-design' } });
});

afterAll(async () => {
  await prisma.voucher.deleteMany({ where: { clientId: 'aoyama-design' } });
  await prisma.$disconnect();
});

describe('generateReminderDraft', () => {
  it('returns subject and body when client has unmatched vouchers', async () => {
    // Create 2 unmatched vouchers
    await prisma.voucher.createMany({
      data: [
        {
          firmId: 'demo-firm',
          clientId: 'aoyama-design',
          filename: 'a.jpg',
          mimeType: 'image/jpeg',
          size: 1,
          imageData: Buffer.from([0x00]),
          matchStatus: 'unmatched',
        },
        {
          firmId: 'demo-firm',
          clientId: 'aoyama-design',
          filename: 'b.jpg',
          mimeType: 'image/jpeg',
          size: 1,
          imageData: Buffer.from([0x00]),
          matchStatus: 'unmatched',
        },
      ],
    });

    const result = await generateReminderDraft('aoyama-design');

    expect(result).not.toBeNull();
    expect(typeof result!.subject).toBe('string');
    expect(result!.subject.length).toBeGreaterThan(0);
    expect(typeof result!.body).toBe('string');
    expect(result!.body.length).toBeGreaterThan(0);
  });

  it('returns subject and body when client has zero unmatched vouchers', async () => {
    // No vouchers — "まだ証憑が届いていない"
    const result = await generateReminderDraft('aoyama-design');

    expect(result).not.toBeNull();
    expect(result!.subject).toBeTruthy();
    expect(result!.body).toBeTruthy();
  });

  it('returns null when client does not exist', async () => {
    const result = await generateReminderDraft('non-existent-client-xyz');
    expect(result).toBeNull();
  });
});
