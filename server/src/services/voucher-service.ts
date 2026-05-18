import { prisma } from '../lib/prisma.js';
import type { Voucher } from '@prisma/client';

export interface VoucherMeta {
  id: string;
  clientId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  uploadedBy: string | null;
  ocrStatus: string;
  matchStatus: string;
}

function toMeta(row: Voucher): VoucherMeta {
  return {
    id: row.id,
    clientId: row.clientId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    uploadedAt: row.uploadedAt,
    uploadedBy: row.uploadedBy,
    ocrStatus: row.ocrStatus,
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

export async function listVouchers(_filter: {
  clientId: string | 'unassigned' | null;
}): Promise<VoucherMeta[]> {
  throw new Error('not implemented');
}

export async function getVoucherImage(
  _id: string,
): Promise<{ mimeType: string; data: Buffer } | null> {
  throw new Error('not implemented');
}

export async function deleteVoucher(_id: string): Promise<boolean> {
  throw new Error('not implemented');
}
