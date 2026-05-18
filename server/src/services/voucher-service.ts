import { prisma } from '../lib/prisma.js';
import type { Voucher } from '@prisma/client';
import { extractVoucherFields } from './ocr-service.js';

export interface VoucherMeta {
  id: string;
  clientId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  uploadedBy: string | null;
  ocrStatus: string;
  ocrJson: unknown;
  ocrError: string | null;
  ocrAt: Date | null;
  matchStatus: string;
}

function toMeta(row: Pick<Voucher, keyof VoucherMeta>): VoucherMeta {
  return {
    id: row.id,
    clientId: row.clientId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    uploadedAt: row.uploadedAt,
    uploadedBy: row.uploadedBy,
    ocrStatus: row.ocrStatus,
    ocrJson: row.ocrJson as unknown,
    ocrError: row.ocrError,
    ocrAt: row.ocrAt,
    matchStatus: row.matchStatus,
  };
}

export async function createVoucher(input: {
  clientId: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy: string | null;
}): Promise<VoucherMeta> {
  const row = await prisma.voucher.create({
    data: {
      clientId: input.clientId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
      imageData: input.buffer,
      uploadedBy: input.uploadedBy,
    },
  });
  return toMeta(row);
}

export async function listVouchers(filter: {
  clientId: string | 'unassigned' | null;
}): Promise<VoucherMeta[]> {
  const where =
    filter.clientId === null
      ? {}
      : filter.clientId === 'unassigned'
        ? { clientId: null }
        : { clientId: filter.clientId };
  const rows = await prisma.voucher.findMany({
    where,
    orderBy: { uploadedAt: 'desc' },
    select: {
      id: true,
      clientId: true,
      filename: true,
      mimeType: true,
      size: true,
      uploadedAt: true,
      uploadedBy: true,
      ocrStatus: true,
      ocrJson: true,
      ocrError: true,
      ocrAt: true,
      matchStatus: true,
    },
  });
  return rows.map(toMeta);
}

export async function getVoucherImage(
  id: string,
): Promise<{ mimeType: string; data: Buffer } | null> {
  const row = await prisma.voucher.findUnique({
    where: { id },
    select: { mimeType: true, imageData: true },
  });
  if (!row) return null;
  return { mimeType: row.mimeType, data: Buffer.from(row.imageData) };
}

export async function deleteVoucher(id: string): Promise<boolean> {
  const result = await prisma.voucher.deleteMany({ where: { id } });
  return result.count > 0;
}

export async function runOcrForVoucher(id: string): Promise<void> {
  const row = await prisma.voucher.findUnique({
    where: { id },
    select: { id: true, imageData: true, mimeType: true },
  });
  if (!row) return;
  await prisma.voucher.update({
    where: { id },
    data: { ocrStatus: 'processing' },
  });
  try {
    const result = await extractVoucherFields(
      Buffer.from(row.imageData),
      row.mimeType,
    );
    await prisma.voucher.update({
      where: { id },
      data: {
        ocrStatus: 'done',
        ocrJson: result,
        ocrAt: new Date(),
        ocrError: null,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.voucher.update({
      where: { id },
      data: { ocrStatus: 'failed', ocrError: msg, ocrAt: new Date() },
    });
  }
}
