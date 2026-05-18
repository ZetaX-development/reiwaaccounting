import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
  deleteVoucher,
  runOcrForVoucher,
} from '../../src/services/voucher-service.js';
import * as ocrService from '../../src/services/ocr-service.js';

beforeEach(async () => {
  await prisma.voucher.deleteMany();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.$disconnect();
});

describe('createVoucher', () => {
  it('persists the image bytes and returns metadata with defaults', async () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const meta = await createVoucher({
      clientId: 'aoyama-design',
      filename: 'IMG_0421.jpg',
      mimeType: 'image/jpeg',
      buffer,
      uploadedBy: 'スタッフ',
    });
    expect(meta.id).toBeTruthy();
    expect(meta.clientId).toBe('aoyama-design');
    expect(meta.filename).toBe('IMG_0421.jpg');
    expect(meta.mimeType).toBe('image/jpeg');
    expect(meta.size).toBe(4);
    expect(meta.uploadedBy).toBe('スタッフ');
    expect(meta.ocrStatus).toBe('pending');
    expect(meta.matchStatus).toBe('unmatched');

    const row = await prisma.voucher.findUnique({ where: { id: meta.id } });
    expect(row?.imageData).toEqual(buffer);
  });

  it('allows clientId null for the unassigned pool', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 'a.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      uploadedBy: null,
    });
    expect(meta.clientId).toBeNull();
    expect(meta.uploadedBy).toBeNull();
  });
});

describe('listVouchers', () => {
  beforeEach(async () => {
    await createVoucher({
      clientId: 'aoyama-design',
      filename: 'a.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0x01]),
      uploadedBy: null,
    });
    await createVoucher({
      clientId: 'shibuya-cafe',
      filename: 'b.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0x02]),
      uploadedBy: null,
    });
    await createVoucher({
      clientId: null,
      filename: 'c.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0x03]),
      uploadedBy: null,
    });
  });

  it('filters by clientId cuid', async () => {
    const rows = await listVouchers({ clientId: 'aoyama-design' });
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('a.jpg');
  });

  it('returns unassigned (clientId IS NULL) when filter is "unassigned"', async () => {
    const rows = await listVouchers({ clientId: 'unassigned' });
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('c.jpg');
  });

  it('returns all rows when filter is null', async () => {
    const rows = await listVouchers({ clientId: null });
    expect(rows).toHaveLength(3);
  });
});

describe('getVoucherImage', () => {
  it('returns the raw bytes and mimeType', async () => {
    const buffer = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    const meta = await createVoucher({
      clientId: null,
      filename: 'g.gif',
      mimeType: 'image/gif',
      buffer,
      uploadedBy: null,
    });
    const image = await getVoucherImage(meta.id);
    expect(image).not.toBeNull();
    expect(image!.mimeType).toBe('image/gif');
    expect(image!.data).toEqual(buffer);
  });

  it('returns null when id is unknown', async () => {
    const image = await getVoucherImage('does-not-exist');
    expect(image).toBeNull();
  });
});

describe('deleteVoucher', () => {
  it('removes the row and returns true', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 'd.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89]),
      uploadedBy: null,
    });
    const ok = await deleteVoucher(meta.id);
    expect(ok).toBe(true);
    const row = await prisma.voucher.findUnique({ where: { id: meta.id } });
    expect(row).toBeNull();
  });

  it('returns false when id is unknown', async () => {
    const ok = await deleteVoucher('does-not-exist');
    expect(ok).toBe(false);
  });
});

describe('runOcrForVoucher', () => {
  it('sets ocrStatus=done and saves extracted JSON', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 'a.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8]),
      uploadedBy: null,
    });
    const spy = vi.spyOn(ocrService, 'extractVoucherFields').mockResolvedValue({
      issue_date: '2026-05-15',
      vendor_name: '青山デザイン',
      addressee: null,
      amount: 3200,
      invoice_number: null,
    });
    await runOcrForVoucher(meta.id);
    const row = await prisma.voucher.findUnique({ where: { id: meta.id } });
    expect(row?.ocrStatus).toBe('done');
    expect(row?.ocrJson).toEqual({
      issue_date: '2026-05-15',
      vendor_name: '青山デザイン',
      addressee: null,
      amount: 3200,
      invoice_number: null,
    });
    expect(row?.ocrError).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('sets ocrStatus=failed and saves ocrError on extraction error', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 'b.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8]),
      uploadedBy: null,
    });
    vi.spyOn(ocrService, 'extractVoucherFields').mockRejectedValue(
      new Error('OpenAI 503'),
    );
    await runOcrForVoucher(meta.id);
    const row = await prisma.voucher.findUnique({ where: { id: meta.id } });
    expect(row?.ocrStatus).toBe('failed');
    expect(row?.ocrError).toBe('OpenAI 503');
  });

  it('is a no-op when voucher does not exist', async () => {
    await expect(runOcrForVoucher('does-not-exist')).resolves.toBeUndefined();
  });
});

describe('listVouchers ocr fields', () => {
  it('returns ocrJson, ocrError, ocrAt in the meta', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 'c.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff]),
      uploadedBy: null,
    });
    vi.spyOn(ocrService, 'extractVoucherFields').mockResolvedValue({
      issue_date: '2026-05-15',
      vendor_name: 'X',
      addressee: null,
      amount: 100,
      invoice_number: null,
    });
    await runOcrForVoucher(meta.id);
    const rows = await listVouchers({ clientId: null });
    const row = rows.find((r) => r.id === meta.id);
    expect(row?.ocrJson).toBeTruthy();
    expect(row?.ocrAt).toBeInstanceOf(Date);
  });
});
