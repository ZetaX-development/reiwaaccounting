import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { generateDraftJournal } from '../../src/services/journal-draft-service.js';
import { applyVoucherReply } from '../../src/services/voucher-reply-service.js';

vi.mock('../../src/services/journal-draft-service.js', () => ({
  generateDraftJournal: vi.fn().mockResolvedValue(undefined),
}));

const mockedGenerateDraft = generateDraftJournal as unknown as ReturnType<typeof vi.fn>;

async function createVoucher(): Promise<string> {
  const v = await prisma.voucher.create({
    data: {
      firmId: 'demo-firm',
      clientId: 'aoyama-design',
      source: 'manual',
      filename: 'r.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      imageData: Buffer.from([0, 1, 2, 3]),
      ocrStatus: 'done',
      matchStatus: 'unmatched',
      journalStatus: 'needs_info',
    },
  });
  return v.id;
}

describe('applyVoucherReply', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await prisma.voucher.deleteMany();
  });

  afterAll(async () => {
    await prisma.voucher.deleteMany();
    await prisma.$disconnect();
  });

  it('stores the reply text and re-drafts the journal', async () => {
    const id = await createVoucher();

    const ok = await applyVoucherReply(id, '参加者は田中さんと佐藤さん、店舗は新橋店です');

    expect(ok).toBe(true);
    const row = await prisma.voucher.findUnique({ where: { id } });
    const answers = (row?.lineAnswers ?? {}) as Record<string, string>;
    expect(answers['メール返信']).toBe('参加者は田中さんと佐藤さん、店舗は新橋店です');
    // 再ドラフトは setImmediate でバックグラウンド実行されるので、次の tick まで待つ
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedGenerateDraft).toHaveBeenCalledWith(id);
  });

  it('merges with existing answers', async () => {
    const id = await createVoucher();
    await prisma.voucher.update({
      where: { id },
      data: { lineAnswers: { 既存: 'x' } },
    });

    await applyVoucherReply(id, '追加の回答');

    const row = await prisma.voucher.findUnique({ where: { id } });
    const answers = (row?.lineAnswers ?? {}) as Record<string, string>;
    expect(answers['既存']).toBe('x');
    expect(answers['メール返信']).toBe('追加の回答');
  });

  it('returns false for a missing voucher', async () => {
    const ok = await applyVoucherReply('does-not-exist', 'text');
    expect(ok).toBe(false);
    expect(mockedGenerateDraft).not.toHaveBeenCalled();
  });
});
