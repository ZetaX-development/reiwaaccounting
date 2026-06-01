import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { inquireAboutVoucher } from '../../src/services/outreach-service.js';
import { __resetEnvCache } from '../../src/env.js';

beforeEach(async () => {
  process.env.OUTREACH_CHANNEL = 'mock';
  __resetEnvCache();
  await prisma.voucherInquiry.deleteMany();
  await prisma.voucher.deleteMany();
});

afterAll(async () => {
  await prisma.voucherInquiry.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.$disconnect();
});

async function createVoucherFixture(source = 'manual'): Promise<string> {
  const v = await prisma.voucher.create({
    data: {
      firmId: 'demo-firm',
      clientId: 'aoyama-design',
      source,
      filename: 'sample.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      imageData: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      ocrStatus: 'done',
      ocrJson: {
        issue_date: '2026-05-15',
        vendor_name: 'ハラペコステーキ',
        addressee: null,
        amount: 8000,
        invoice_number: null,
      } as never,
      matchStatus: 'unmatched',
      journalStatus: 'needs_info',
      draftJournalJson: {
        account: '接待交際費',
        taxClass: '課税仕入10%',
        description: '会食',
        amount: 8000,
        occurredAt: '2026-05-15',
        missingFields: ['会食の参加者'],
        reasoning: '宛名が空',
      } as never,
    },
  });
  return v.id;
}

describe('inquireAboutVoucher', () => {
  it('records inquiry via mock channel', async () => {
    process.env.OUTREACH_CHANNEL = 'mock';
    __resetEnvCache();
    const id = await createVoucherFixture();

    await inquireAboutVoucher(id);

    const inquiries = await prisma.voucherInquiry.findMany({
      where: { voucherId: id },
    });
    expect(inquiries).toHaveLength(1);
    expect(inquiries[0].channel).toBe('mock');
    expect(inquiries[0].status).toBe('sent');
    expect(inquiries[0].body).toContain('会食の参加者');

    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.inquiryAt).not.toBeNull();
    expect(row?.inquiryChannel).toBe('mock');
    expect(row?.journalStatus).toBe('inquired');
  });

  it('skips LINE-sourced vouchers (handled by the LINE push path)', async () => {
    process.env.OUTREACH_CHANNEL = 'mock';
    __resetEnvCache();
    const id = await createVoucherFixture('line');

    await inquireAboutVoucher(id);

    const inquiries = await prisma.voucherInquiry.findMany({ where: { voucherId: id } });
    expect(inquiries).toHaveLength(0);
    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.inquiryAt).toBeNull();
    expect(row?.journalStatus).toBe('needs_info');
  });

  it('sends web/drive inquiries to the hardcoded demo address', async () => {
    process.env.OUTREACH_CHANNEL = 'mock';
    __resetEnvCache();
    for (const source of ['manual', 'drive']) {
      const id = await createVoucherFixture(source);
      await inquireAboutVoucher(id);
      const inquiries = await prisma.voucherInquiry.findMany({ where: { voucherId: id } });
      expect(inquiries).toHaveLength(1);
      expect(inquiries[0].channel).toBe('mock');
      expect(inquiries[0].target).toBe('kkouta2017@gmail.com');
    }
  });

  it('records failure when channel adapter is not implemented', async () => {
    process.env.OUTREACH_CHANNEL = 'email';
    // .env (Prisma 経由でロードされる) のキーに依存せず「未設定なら失敗」を決定的に検証する
    delete process.env.RESEND_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    __resetEnvCache();
    const id = await createVoucherFixture();

    await inquireAboutVoucher(id);

    const inquiries = await prisma.voucherInquiry.findMany({
      where: { voucherId: id },
    });
    expect(inquiries).toHaveLength(1);
    expect(inquiries[0].channel).toBe('email');
    expect(inquiries[0].status).toBe('failed');
    expect(inquiries[0].errorMessage).toBe('SENDGRID_API_KEY is not set');
  });
});
