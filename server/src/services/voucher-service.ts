import { prisma } from '../lib/prisma.js';
import type { Voucher } from '@prisma/client';
import { env } from '../env.js';
import { extractVoucherFields } from './ocr-service.js';
import { assignVoucherToClient } from './voucher-assign-service.js';
import { findMatchForVoucher } from './matching-service.js';
import { generateDraftJournal } from './journal-draft-service.js';
import { inquireAboutVoucher } from './outreach-service.js';

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
  matchedEntryId: string | null;
  matchedAt: Date | null;
  matchedClientReason: string | null;
  draftJournalJson: unknown;
  journalStatus: string;
  inquiryAt: Date | null;
  inquiryChannel: string | null;
  source: string;
  caption: string | null;
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
    matchedEntryId: row.matchedEntryId,
    matchedAt: row.matchedAt,
    matchedClientReason: row.matchedClientReason,
    draftJournalJson: row.draftJournalJson as unknown,
    journalStatus: row.journalStatus,
    inquiryAt: row.inquiryAt,
    inquiryChannel: row.inquiryChannel,
    source: row.source,
    caption: row.caption,
  };
}

export async function createVoucher(input: {
  clientId: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy: string | null;
  firmId?: string;
}): Promise<VoucherMeta> {
  const row = await prisma.voucher.create({
    data: {
      firmId: input.firmId ?? 'demo-firm',
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
  firmId: string;
}): Promise<VoucherMeta[]> {
  const where: Record<string, unknown> =
    filter.clientId === null
      ? { firmId: filter.firmId }
      : filter.clientId === 'unassigned'
        ? { clientId: null, firmId: filter.firmId }
        : { clientId: filter.clientId, firmId: filter.firmId };
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
      matchedEntryId: true,
      matchedAt: true,
      matchedClientReason: true,
      draftJournalJson: true,
      journalStatus: true,
      inquiryAt: true,
      inquiryChannel: true,
      source: true,
      caption: true,
    },
  });
  return rows.map(toMeta);
}

export async function getVoucherImage(
  id: string,
  firmId: string,
): Promise<{ mimeType: string; data: Buffer } | null> {
  const row = await prisma.voucher.findFirst({
    where: { id, firmId },
    select: { mimeType: true, imageData: true },
  });
  if (!row) return null;
  return { mimeType: row.mimeType, data: Buffer.from(row.imageData) };
}

export async function deleteVoucher(id: string, firmId: string): Promise<boolean> {
  const result = await prisma.voucher.deleteMany({ where: { id, firmId } });
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
    if (env.OPENAI_API_KEY) {
      setImmediate(() => {
        assignAndMatchVoucher(id).catch(() => {});
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.voucher.update({
      where: { id },
      data: { ocrStatus: 'failed', ocrError: msg, ocrAt: new Date() },
    });
  }
}

export async function assignAndMatchVoucher(id: string): Promise<void> {
  const v = await prisma.voucher.findUnique({
    where: { id },
    select: { clientId: true, ocrStatus: true },
  });
  if (!v || v.ocrStatus !== 'done') return;

  let reason: string | null = v.clientId ? 'manual' : null;
  if (!v.clientId) {
    const assigned = await assignVoucherToClient(id);
    if (assigned.clientId) {
      await prisma.voucher.update({
        where: { id },
        data: {
          clientId: assigned.clientId,
          matchedClientReason: assigned.reason,
        },
      });
      reason = assigned.reason;
    } else {
      reason = assigned.reason;
    }
  }

  const match = await findMatchForVoucher(id);
  const exists = await prisma.voucher.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!exists) return;
  await prisma.voucher.update({
    where: { id },
    data: {
      matchStatus: match.status,
      matchedEntryId: match.matchedEntryId,
      matchedAt: new Date(),
      ...(reason ? { matchedClientReason: reason } : {}),
    },
  });

  // Spec 14: whenever the voucher didn't land on a matched MF entry, generate
  // a draft journal so the staff has something concrete to review — covers
  // both 'unmatched' (no candidate found) and 'no_client' (AI couldn't pick a
  // client, so the user will reassign manually) cases. Stays fire-and-forget.
  if (match.status !== 'matched' && env.OPENAI_API_KEY) {
    await generateDraftJournal(id);
    if (env.OUTREACH_AUTO) {
      const after = await prisma.voucher.findUnique({
        where: { id },
        select: { journalStatus: true },
      });
      if (after?.journalStatus === 'needs_info') {
        await inquireAboutVoucher(id);
      }
    }
  }

  // Spec 16: if this Voucher came in via LINE and we have a token,
  // push a status / Quick Reply back to the sender. Fire-and-forget;
  // dynamic import keeps the voucher-service ↔ line-importer cycle broken.
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    const after = await prisma.voucher.findUnique({
      where: { id },
      select: { source: true, lineUserId: true },
    });
    if (after?.source === 'line' && after.lineUserId) {
      setImmediate(() => {
        void (async () => {
          try {
            const { sendLinePushForVoucherStatus } = await import(
              './line-importer.js'
            );
            await sendLinePushForVoucherStatus(id);
          } catch {
            /* swallow */
          }
        })();
      });
    }
  }
}
