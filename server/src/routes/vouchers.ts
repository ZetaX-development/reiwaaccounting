import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
  deleteVoucher,
  runOcrForVoucher,
  countInboundSince,
  listInboundRecent,
} from '../services/voucher-service.js';
import { findMatchForVoucher } from '../services/matching-service.js';
import { generateDraftJournal } from '../services/journal-draft-service.js';
import { inquireAboutVoucher } from '../services/outreach-service.js';
import { applyVoucherReply } from '../services/voucher-reply-service.js';
import { writeJournalToMf } from '../services/mf-browser-service.js';
import { prisma } from '../lib/prisma.js';

type CsvFormat = 'yayoi' | 'mf' | 'generic';
type ExportStatus = 'drafted' | 'approved' | 'all';

type DraftLeg = {
  account?: string | null;
  subAccount?: string | null;
  partner?: string | null;
  taxClass?: string | null;
  invoiceNumber?: string | null;
  amount?: number | string | null;
};

type DraftJournal = {
  transactionDate?: string | null;
  occurredAt?: string | null;
  debit?: DraftLeg | null;
  credit?: DraftLeg | null;
  description?: string | null;
  confidence?: number | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YAYOI_HEADER = [
  '伝票番号',
  '伝票日付',
  '借方勘定科目',
  '借方補助科目',
  '借方部門',
  '借方税区分',
  '借方金額',
  '借方消費税額',
  '貸方勘定科目',
  '貸方補助科目',
  '貸方部門',
  '貸方税区分',
  '貸方金額',
  '貸方消費税額',
  '摘要',
  'メモ',
  '付箋1',
  '付箋2',
  '証憑ファイル名',
] as const;
const MF_HEADER = ['取引日', '決済口座', '取引内容', '金額（円）', 'メモ'] as const;
const GENERIC_HEADER = [
  '日付',
  '借方勘定科目',
  '借方金額',
  '借方税区分',
  '貸方勘定科目',
  '貸方金額',
  '貸方税区分',
  '摘要',
  '証憑ID',
  '信頼度',
] as const;

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function serializeCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}

function asDraftJournal(input: unknown): DraftJournal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as DraftJournal;
}

function normalizeDateString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (DATE_RE.test(raw)) return raw;
  const head = raw.slice(0, 10);
  return DATE_RE.test(head) ? head : null;
}

function numberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function mapYayoiTaxClass(taxClass: string | null | undefined): string {
  if (taxClass === '課税10%') return '課税10%';
  if (taxClass === '課税8%（軽減）') return '軽減税率';
  if (taxClass === null || taxClass === undefined) return '';
  return taxClass;
}

function calcTaxAmount(amount: number, taxClass: string | null | undefined): number {
  if (amount <= 0) return 0;
  if (taxClass === '課税10%') return Math.floor(amount / 11);
  if (taxClass === '課税8%（軽減）') return Math.floor((amount / 109) * 9);
  return 0;
}

function isWithinDateRange(
  date: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function buildYayoiCsv(rows: Array<{ filename: string; draft: DraftJournal; txDate: string }>): string {
  const records: unknown[][] = [Array.from(YAYOI_HEADER)];
  for (const row of rows) {
    const debit = row.draft.debit ?? {};
    const credit = row.draft.credit ?? {};
    const debitAmount = numberOrZero(debit.amount);
    const creditAmount = numberOrZero(credit.amount);
    records.push([
      '',
      row.txDate,
      debit.account ?? '',
      debit.subAccount ?? '',
      '',
      mapYayoiTaxClass(debit.taxClass),
      debitAmount,
      calcTaxAmount(debitAmount, debit.taxClass),
      credit.account ?? '',
      credit.subAccount ?? '',
      '',
      mapYayoiTaxClass(credit.taxClass),
      creditAmount,
      calcTaxAmount(creditAmount, credit.taxClass),
      row.draft.description ?? '',
      '',
      '',
      '',
      row.filename ?? '',
    ]);
  }
  return `\uFEFF${serializeCsv(records)}`;
}

function buildMfCsv(rows: Array<{ draft: DraftJournal; txDate: string }>): string {
  const records: unknown[][] = [Array.from(MF_HEADER)];
  for (const row of rows) {
    const debit = row.draft.debit ?? {};
    records.push([
      row.txDate,
      debit.account ?? '',
      row.draft.description ?? '',
      numberOrZero(debit.amount),
      '',
    ]);
  }
  return serializeCsv(records);
}

function buildGenericCsv(
  rows: Array<{ id: string; draft: DraftJournal; txDate: string }>,
): string {
  const records: unknown[][] = [Array.from(GENERIC_HEADER)];
  for (const row of rows) {
    const debit = row.draft.debit ?? {};
    const credit = row.draft.credit ?? {};
    records.push([
      row.txDate,
      debit.account ?? '',
      numberOrZero(debit.amount),
      debit.taxClass ?? '',
      credit.account ?? '',
      numberOrZero(credit.amount),
      credit.taxClass ?? '',
      row.draft.description ?? '',
      row.id,
      row.draft.confidence ?? '',
    ]);
  }
  return serializeCsv(records);
}

async function runMatchAndPersist(id: string): Promise<void> {
  const m = await findMatchForVoucher(id);
  const exists = await prisma.voucher.findUnique({
    where: { id },
    select: { id: true, journalStatus: true },
  });
  if (!exists) return;
  await prisma.voucher.update({
    where: { id },
    data: {
      matchStatus: m.status,
      matchedEntryId: m.matchedEntryId,
      matchedAt: new Date(),
    },
  });
  // Spec 14: if the rematch didn't land and we don't already have a draft
  // journal (or it bailed out as 'none'), generate one so the staff sees the
  // suggestion immediately after manual reassignment.
  if (
    m.status !== 'matched' &&
    process.env.OPENAI_API_KEY &&
    (exists.journalStatus === 'none' || !exists.journalStatus)
  ) {
    await generateDraftJournal(id);
  }
}

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export async function voucherRoutes(app: FastifyInstance) {
  // spec 27: LINE/Drive からの証憑投入を検知するための集計エンドポイント。
  app.get('/api/vouchers/inbound-since', async (req) => {
    const { since } = req.query as { since?: string };
    let sinceDate: Date | null = null;
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) sinceDate = d;
    }
    const result = await countInboundSince(req.user!.firmId, sinceDate);
    return {
      now: result.now.toISOString(),
      total: result.total,
      counts: result.counts,
    };
  });

  // spec 31: 通知センター用。最近の LINE/Drive 証憑を一覧で返す。
  app.get('/api/vouchers/inbound-recent', async (req) => {
    const { limit } = req.query as { limit?: string };
    const n = limit ? Number(limit) : 20;
    const result = await listInboundRecent(req.user!.firmId, Number.isFinite(n) ? n : 20);
    return result.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString() }));
  });

  app.post('/api/vouchers', async (req, reply) => {
    let data;
    try {
      data = await req.file();
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        reply.code(400);
        return {
          error: { code: 'FILE_TOO_LARGE', message: 'file exceeds 10MB' },
        };
      }
      throw err;
    }
    if (!data) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: 'file is required' } };
    }
    if (!ALLOWED_MIMES.has(data.mimetype)) {
      reply.code(400);
      return {
        error: {
          code: 'INVALID_MIME',
          message: `unsupported mime type: ${data.mimetype}`,
        },
      };
    }
    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        reply.code(400);
        return {
          error: { code: 'FILE_TOO_LARGE', message: 'file exceeds 10MB' },
        };
      }
      throw err;
    }
    const clientIdField = data.fields.clientId;
    const clientId =
      clientIdField && 'value' in clientIdField
        ? (clientIdField.value as string)
        : null;
    const uploadedBy =
      typeof req.headers['x-uploaded-by'] === 'string'
        ? req.headers['x-uploaded-by']
        : null;
    const meta = await createVoucher({
      clientId,
      filename: data.filename,
      mimeType: data.mimetype,
      buffer,
      uploadedBy,
      firmId: req.user!.firmId,
    });
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 0) {
      setImmediate(() => {
        runOcrForVoucher(meta.id).catch(() => {});
      });
    }
    reply.code(201);
    return meta;
  });

  app.get<{
    Querystring: { clientId?: string };
  }>('/api/vouchers', async (req) => {
    const q = req.query.clientId;
    const filter: { clientId: string | 'unassigned' | null; firmId: string } = !q
      ? { clientId: null, firmId: req.user!.firmId }
      : q === 'unassigned'
        ? { clientId: 'unassigned', firmId: req.user!.firmId }
        : { clientId: q, firmId: req.user!.firmId };
    return listVouchers(filter);
  });

  app.get<{ Params: { id: string } }>(
    '/api/vouchers/:id/image',
    async (req, reply) => {
      const image = await getVoucherImage(req.params.id, req.user!.firmId);
      if (!image) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      reply
        .header('content-type', image.mimeType)
        .header('cache-control', 'private, max-age=300');
      return image.data;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/vouchers/:id',
    async (req, reply) => {
      const ok = await deleteVoucher(req.params.id, req.user!.firmId);
      if (!ok) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/vouchers/:id/ocr',
    async (req, reply) => {
      const row = await prisma.voucher.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!row) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      setImmediate(() => {
        runOcrForVoucher(req.params.id).catch(() => {});
      });
      reply.code(202);
      return { ok: true };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { clientId?: string | null };
  }>('/api/vouchers/:id', async (req, reply) => {
    const row = await prisma.voucher.findFirst({
      where: { id: req.params.id, firmId: req.user!.firmId },
      select: { id: true },
    });
    if (!row) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
    }
    const newClientId = req.body?.clientId ?? null;
    // Validate that the target client belongs to the same firm.
    if (newClientId) {
      const client = await prisma.client.findFirst({
        where: { id: newClientId, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!client) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'client not found' } };
      }
    }
    await prisma.voucher.update({
      where: { id: req.params.id },
      data: { clientId: newClientId, matchedClientReason: 'manual' },
    });
    setImmediate(() => {
      runMatchAndPersist(req.params.id).catch(() => {});
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    '/api/vouchers/:id/match',
    async (req, reply) => {
      const row = await prisma.voucher.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!row) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      setImmediate(() => {
        runMatchAndPersist(req.params.id).catch(() => {});
      });
      reply.code(202);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/vouchers/:id/draft-journal',
    async (req, reply) => {
      const row = await prisma.voucher.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!row) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      setImmediate(() => {
        generateDraftJournal(req.params.id).catch(() => {});
      });
      reply.code(202);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/vouchers/:id/inquire',
    async (req, reply) => {
      const row = await prisma.voucher.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!row) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      setImmediate(() => {
        inquireAboutVoucher(req.params.id).catch(() => {});
      });
      reply.code(202);
      return { ok: true };
    },
  );

  // spec 29: 顧客のメール返信を取り込んで仕訳ドラフトを作り直す（疑似受信。本文を直接渡す）
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/api/vouchers/:id/email-reply',
    async (req, reply) => {
      const text = (req.body?.text ?? '').trim();
      if (!text) {
        reply.code(400);
        return { error: { code: 'BAD_REQUEST', message: 'text is required' } };
      }
      const row = await prisma.voucher.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!row) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      await applyVoucherReply(req.params.id, text);
      return { ok: true };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: {
      format?: CsvFormat;
      status?: ExportStatus;
      from?: string;
      to?: string;
    };
  }>('/api/clients/:id/vouchers/export-csv', async (req, reply) => {
    const format = req.query.format ?? 'generic';
    const status = req.query.status ?? 'all';
    const from = req.query.from;
    const to = req.query.to;
    if (format !== 'yayoi' && format !== 'mf' && format !== 'generic') {
      reply.code(400);
      return { error: { code: 'INVALID_QUERY', message: 'format must be yayoi|mf|generic' } };
    }
    if (status !== 'drafted' && status !== 'approved' && status !== 'all') {
      reply.code(400);
      return { error: { code: 'INVALID_QUERY', message: 'status must be drafted|approved|all' } };
    }
    if (from && !DATE_RE.test(from)) {
      reply.code(400);
      return { error: { code: 'INVALID_QUERY', message: 'from must be YYYY-MM-DD' } };
    }
    if (to && !DATE_RE.test(to)) {
      reply.code(400);
      return { error: { code: 'INVALID_QUERY', message: 'to must be YYYY-MM-DD' } };
    }
    if (from && to && from > to) {
      reply.code(400);
      return { error: { code: 'INVALID_QUERY', message: 'from must be <= to' } };
    }

    const client = await prisma.client.findFirst({
      where: { id: req.params.id, firmId: req.user!.firmId },
      select: { id: true },
    });
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }

    const vouchers = await prisma.voucher.findMany({
      where: {
        firmId: req.user!.firmId,
        clientId: client.id,
        draftJournalJson: { not: Prisma.AnyNull },
        ...(status === 'all' ? {} : { journalStatus: status }),
      },
      orderBy: { uploadedAt: 'asc' },
      select: {
        id: true,
        filename: true,
        uploadedAt: true,
        draftJournalJson: true,
      },
    });

    const prepared = vouchers
      .map((voucher) => {
        const draft = asDraftJournal(voucher.draftJournalJson);
        const txDate =
          normalizeDateString(draft.transactionDate) ??
          normalizeDateString(draft.occurredAt) ??
          voucher.uploadedAt.toISOString().slice(0, 10);
        return { id: voucher.id, filename: voucher.filename, draft, txDate };
      })
      .filter((voucher) => isWithinDateRange(voucher.txDate, from, to));

    const csv =
      format === 'yayoi'
        ? buildYayoiCsv(prepared)
        : format === 'mf'
          ? buildMfCsv(prepared)
          : buildGenericCsv(prepared);

    const today = new Date().toISOString().slice(0, 10);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="journals-${today}.csv"`);
    return csv;
  });

  // Spec 20: UI から MF 仕訳登録をトリガーする
  app.post<{ Params: { id: string; voucherId: string } }>(
    '/api/clients/:id/vouchers/:voucherId/mf-retry',
    async (req, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!client) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'client not found' } };
      }
      const voucher = await prisma.voucher.findFirst({
        where: {
          id: req.params.voucherId,
          clientId: client.id,
          firmId: req.user!.firmId,
        },
        select: { id: true, journalStatus: true },
      });
      if (!voucher) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      if (!voucher.journalStatus || voucher.journalStatus === 'none') {
        reply.code(400);
        return {
          error: {
            code: 'NO_DRAFT',
            message: '仕訳ドラフトがまだありません。先にドラフトを生成してください。',
          },
        };
      }
      await prisma.voucher.update({
        where: { id: voucher.id },
        data: { mfWriteStatus: 'pending', mfWriteError: null },
      });
      setImmediate(() => {
        writeJournalToMf(voucher.id).catch(() => {});
      });
      reply.code(202);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/vouchers/:id/mf-write',
    async (req, reply) => {
      const row = await prisma.voucher.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true, journalStatus: true },
      });
      if (!row) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      if (!row.journalStatus || row.journalStatus === 'none') {
        reply.code(400);
        return {
          error: {
            code: 'NO_DRAFT',
            message: '仕訳ドラフトがまだありません。先にドラフトを生成してください。',
          },
        };
      }
      await prisma.voucher.update({
        where: { id: req.params.id },
        data: { mfWriteStatus: 'pending' },
      });
      setImmediate(() => {
        writeJournalToMf(req.params.id).catch(() => {});
      });
      reply.code(202);
      return { ok: true };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      account?: string;
      taxClass?: string | null;
      description?: string;
      amount?: number;
      occurredAt?: string;
      status?: string;
    };
  }>('/api/vouchers/:id/journal', async (req, reply) => {
    const row = await prisma.voucher.findFirst({
      where: { id: req.params.id, firmId: req.user!.firmId },
      select: { id: true, draftJournalJson: true },
    });
    if (!row) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
    }
    const body = req.body || {};
    const existing = (row.draftJournalJson as Record<string, unknown> | null) ?? {};
    const merged: Record<string, unknown> = { ...existing };
    if (body.account !== undefined) merged.account = body.account;
    if (body.taxClass !== undefined) merged.taxClass = body.taxClass;
    if (body.description !== undefined) merged.description = body.description;
    if (body.amount !== undefined) merged.amount = body.amount;
    if (body.occurredAt !== undefined) merged.occurredAt = body.occurredAt;

    const update: Record<string, unknown> = { draftJournalJson: merged };
    if (body.status) update.journalStatus = body.status;
    await prisma.voucher.update({
      where: { id: req.params.id },
      data: update,
    });
    return { ok: true };
  });
}
