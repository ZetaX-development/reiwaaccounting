import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
  deleteVoucher,
} from '../../src/services/voucher-service.js';

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
