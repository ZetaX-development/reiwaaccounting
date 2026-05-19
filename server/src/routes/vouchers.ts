import type { FastifyInstance } from 'fastify';
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
  deleteVoucher,
  runOcrForVoucher,
} from '../services/voucher-service.js';
import { findMatchForVoucher } from '../services/matching-service.js';
import { generateDraftJournal } from '../services/journal-draft-service.js';
import { inquireAboutVoucher } from '../services/outreach-service.js';
import { prisma } from '../lib/prisma.js';

async function runMatchAndPersist(id: string): Promise<void> {
  const m = await findMatchForVoucher(id);
  const exists = await prisma.voucher.findUnique({
    where: { id },
    select: { id: true },
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
}

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export async function voucherRoutes(app: FastifyInstance) {
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
    const filter: { clientId: string | 'unassigned' | null } = !q
      ? { clientId: null }
      : q === 'unassigned'
        ? { clientId: 'unassigned' }
        : { clientId: q };
    return listVouchers(filter);
  });

  app.get<{ Params: { id: string } }>(
    '/api/vouchers/:id/image',
    async (req, reply) => {
      const image = await getVoucherImage(req.params.id);
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
      const ok = await deleteVoucher(req.params.id);
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
      const row = await prisma.voucher.findUnique({
        where: { id: req.params.id },
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
    const row = await prisma.voucher.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!row) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
    }
    const newClientId = req.body?.clientId ?? null;
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
      const row = await prisma.voucher.findUnique({
        where: { id: req.params.id },
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
      const row = await prisma.voucher.findUnique({
        where: { id: req.params.id },
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
      const row = await prisma.voucher.findUnique({
        where: { id: req.params.id },
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
    const row = await prisma.voucher.findUnique({
      where: { id: req.params.id },
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
