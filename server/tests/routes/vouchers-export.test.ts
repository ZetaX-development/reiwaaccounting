import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { authHeaders } from '../helpers/auth.js';

const app = await buildApp();
const auth = await authHeaders();

const ISOLATION_FIRMS = ['tenant-isolation-firm-export-1'];
const YAYOI_HEADER =
  '伝票番号,伝票日付,借方勘定科目,借方補助科目,借方部門,借方税区分,借方金額,借方消費税額,貸方勘定科目,貸方補助科目,貸方部門,貸方税区分,貸方金額,貸方消費税額,摘要,メモ,付箋1,付箋2,証憑ファイル名';

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  await prisma.client.deleteMany({
    where: { name: { startsWith: 'CSVテスト顧問先' } },
  });
  await prisma.firm.deleteMany({ where: { id: { in: ISOLATION_FIRMS } } });
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.client.deleteMany({
    where: { name: { startsWith: 'CSVテスト顧問先' } },
  });
  await prisma.firm.deleteMany({ where: { id: { in: ISOLATION_FIRMS } } });
  await app.close();
});

describe('GET /api/clients/:id/vouchers/export-csv', () => {
  it('returns Yayoi CSV with UTF-8 BOM and expected header', async () => {
    const client = await prisma.client.create({
      data: {
        firmId: 'demo-firm',
        name: 'CSVテスト顧問先 A',
        fiscalYearStart: new Date('2026-01-01'),
        fiscalYearEnd: new Date('2026-12-31'),
      },
    });
    await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: client.id,
        filename: 'included.jpg',
        mimeType: 'image/jpeg',
        size: 4,
        imageData: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        journalStatus: 'drafted',
        draftJournalJson: {
          transactionDate: '2026-05-15',
          debit: {
            account: '会議費',
            subAccount: null,
            partner: null,
            taxClass: '課税10%',
            invoiceNumber: null,
            amount: 3000,
          },
          credit: {
            account: '現金',
            subAccount: null,
            partner: null,
            taxClass: null,
            invoiceNumber: null,
            amount: 3000,
          },
          description: '取引先との会議費',
          missingFields: [],
          reasoning: 'test',
        },
      },
    });
    await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: client.id,
        filename: 'excluded-null-draft.jpg',
        mimeType: 'image/jpeg',
        size: 4,
        imageData: Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
        journalStatus: 'drafted',
        draftJournalJson: null,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/clients/${client.id}/vouchers/export-csv?format=yayoi&status=drafted`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename=');
    expect(res.rawPayload[0]).toBe(0xef);
    expect(res.rawPayload[1]).toBe(0xbb);
    expect(res.rawPayload[2]).toBe(0xbf);

    const csv = res.rawPayload.toString('utf8');
    const firstLine = csv.split(/\r?\n/)[0].replace(/^\uFEFF/, '');
    expect(firstLine).toBe(YAYOI_HEADER);
    expect(csv).toContain('included.jpg');
    expect(csv).toContain('取引先との会議費');
    expect(csv).not.toContain('excluded-null-draft.jpg');
  });

  it('returns 404 when client belongs to another firm', async () => {
    await prisma.firm.create({
      data: {
        id: 'tenant-isolation-firm-export-1',
        name: 'Other Firm',
        slug: 'tenant-isolation-firm-export-1',
      },
    });
    const otherClient = await prisma.client.create({
      data: {
        firmId: 'tenant-isolation-firm-export-1',
        name: 'CSVテスト顧問先 Other',
        fiscalYearStart: new Date('2026-01-01'),
        fiscalYearEnd: new Date('2026-12-31'),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/clients/${otherClient.id}/vouchers/export-csv?format=yayoi`,
      headers: auth,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
