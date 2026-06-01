import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { authHeaders } from '../helpers/auth.js';

const app = await buildApp();
const auth = await authHeaders();

const OTHER_FIRM = 'inbound-other-firm';

// demo-firm 配下に、source と createdAt を制御した証憑を作る
async function makeVoucher(opts: {
  firmId: string;
  source: string;
  uploadedAt: Date;
}) {
  return prisma.voucher.create({
    data: {
      firmId: opts.firmId,
      source: opts.source,
      uploadedAt: opts.uploadedAt,
      filename: 'x.png',
      mimeType: 'image/png',
      size: 3,
      imageData: Buffer.from([0x89, 0x50, 0x4e]),
    },
  });
}

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await prisma.firm.create({
    data: { id: OTHER_FIRM, name: 'Other', slug: OTHER_FIRM },
  });
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await app.close();
});

describe('GET /api/vouchers/inbound-since', () => {
  // 実時刻からの相対で組む（uploadedAt <= now の境界に引っかからないよう、
  // RECENT は SINCE より後・実 now より前にする）。
  const nowMs = Date.now();
  const HOUR = 60 * 60 * 1000;
  const OLD = new Date(nowMs - 72 * HOUR);
  const SINCE = new Date(nowMs - 2 * HOUR);
  const RECENT = new Date(nowMs - 1 * HOUR);

  it('since 以降の line/drive のみを source 別に数え、manual/別firmを除外する', async () => {
    await makeVoucher({ firmId: 'demo-firm', source: 'line', uploadedAt: OLD });    // 古いので除外
    await makeVoucher({ firmId: 'demo-firm', source: 'line', uploadedAt: RECENT });  // count
    await makeVoucher({ firmId: 'demo-firm', source: 'line', uploadedAt: RECENT });  // count
    await makeVoucher({ firmId: 'demo-firm', source: 'drive', uploadedAt: RECENT }); // count
    await makeVoucher({ firmId: 'demo-firm', source: 'manual', uploadedAt: RECENT });// manual除外
    await makeVoucher({ firmId: OTHER_FIRM, source: 'line', uploadedAt: RECENT });   // 別firm除外

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-since?since=' + encodeURIComponent(SINCE.toISOString()),
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts.line).toBe(2);
    expect(body.counts.drive).toBe(1);
    expect(body.total).toBe(3);
    expect(typeof body.now).toBe('string');
  });

  it('since 未指定なら total=0 で now を返す（過去分を通知しない）', async () => {
    await makeVoucher({ firmId: 'demo-firm', source: 'line', uploadedAt: RECENT });

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-since',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(typeof body.now).toBe('string');
  });
});
