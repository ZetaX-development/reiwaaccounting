import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { authHeaders } from '../helpers/auth.js';

const app = await buildApp();
const auth = await authHeaders();
const OTHER_FIRM = 'inbound-recent-other-firm';

async function mk(opts: {
  firmId: string;
  source: string;
  uploadedAt: Date;
  clientId?: string | null;
  ocrJson?: unknown;
  draftJournalJson?: unknown;
}) {
  return prisma.voucher.create({
    data: {
      firmId: opts.firmId,
      source: opts.source,
      uploadedAt: opts.uploadedAt,
      clientId: opts.clientId ?? null,
      filename: 'x.png',
      mimeType: 'image/png',
      size: 3,
      imageData: Buffer.from([0x89, 0x50, 0x4e]),
      ocrJson: (opts.ocrJson ?? null) as never,
      draftJournalJson: (opts.draftJournalJson ?? null) as never,
    },
  });
}

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await prisma.firm.create({ data: { id: OTHER_FIRM, name: 'Other', slug: OTHER_FIRM } });
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await app.close();
});

describe('GET /api/vouchers/inbound-recent', () => {
  const t = (min: number) => new Date(Date.now() - min * 60000);

  it('returns line/drive only, firm-scoped, newest first, with derived fields', async () => {
    await mk({
      firmId: 'demo-firm', source: 'line', uploadedAt: t(1), clientId: 'shibuya-cafe',
      ocrJson: { vendor_name: 'MOS', amount: 940 },
      draftJournalJson: { debit: { account: '会議費', amount: 940 } },
    });
    await mk({ firmId: 'demo-firm', source: 'drive', uploadedAt: t(5) });
    await mk({ firmId: 'demo-firm', source: 'manual', uploadedAt: t(2) }); // 除外
    await mk({ firmId: OTHER_FIRM, source: 'line', uploadedAt: t(0) });     // 別firm除外

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-recent?limit=20',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2); // line + drive のみ
    // 新しい順: line(1分前) が先頭
    expect(body[0].source).toBe('line');
    expect(body[0].vendor).toBe('MOS');
    expect(body[0].amount).toBe(940);
    expect(body[0].account).toBe('会議費');
    expect(body[0].clientId).toBe('shibuya-cafe');
    expect(typeof body[0].clientName).toBe('string'); // shibuya-cafe の名前
    expect(body[1].source).toBe('drive');
  });

  it('respects limit', async () => {
    await mk({ firmId: 'demo-firm', source: 'line', uploadedAt: t(1) });
    await mk({ firmId: 'demo-firm', source: 'line', uploadedAt: t(2) });
    await mk({ firmId: 'demo-firm', source: 'line', uploadedAt: t(3) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-recent?limit=2',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});
