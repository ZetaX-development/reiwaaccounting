import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listClients, getClientById, createClient, updateClient, deleteClient } from '../services/client-service.js';
import { inquireAboutUnknownWithdrawals } from '../services/outreach-service.js';

const createClientSchema = z.object({
  name: z.string().min(1).max(100),
  fiscalYearStart: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  fiscalYearEnd: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  industry: z.string().optional(),
  vendor: z.string().optional(),
  mode: z.string().optional(),
});

export async function clientRoutes(app: FastifyInstance) {
  app.get('/api/clients', async (req) => {
    return listClients(req.user!.firmId);
  });

  app.post('/api/clients', async (req, reply) => {
    const parsed = createClientSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'invalid body' } };
    }
    const { name, fiscalYearStart, fiscalYearEnd, industry, vendor, mode } = parsed.data;
    const start = new Date(fiscalYearStart);
    const end = new Date(fiscalYearEnd);
    if (end <= start) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: 'fiscalYearEnd must be after fiscalYearStart' } };
    }
    const client = await createClient(
      { name, fiscalYearStart: start, fiscalYearEnd: end, industry, vendor, mode },
      req.user!.firmId,
    );
    reply.code(201);
    return client;
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      industry?: string;
      vendor?: string;
      mode?: string;
      fiscalYearStart?: string;
      fiscalYearEnd?: string;
      memo?: string | null;
      tags?: string[];
      crmStatus?: string;
      lastContactAt?: string | null;
    };
  }>('/api/clients/:id', async (req, reply) => {
    const body = req.body || {};
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.industry !== undefined) data.industry = body.industry;
    if (body.vendor !== undefined) data.vendor = body.vendor;
    if (body.mode !== undefined) data.mode = body.mode;
    if (body.fiscalYearStart !== undefined) data.fiscalYearStart = new Date(body.fiscalYearStart);
    if (body.fiscalYearEnd !== undefined) data.fiscalYearEnd = new Date(body.fiscalYearEnd);
    if (body.memo !== undefined) data.memo = body.memo;
    if (body.tags !== undefined) data.tags = body.tags;
    if (body.crmStatus !== undefined) data.crmStatus = body.crmStatus;
    if (body.lastContactAt !== undefined) {
      data.lastContactAt = body.lastContactAt ? new Date(body.lastContactAt) : null;
    }
    const ok = await updateClient(req.params.id, req.user!.firmId, data);
    if (!ok) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/clients/:id', async (req, reply) => {
    const ok = await deleteClient(req.params.id, req.user!.firmId);
    if (!ok) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/clients/:id', async (req, reply) => {
    const client = await getClientById(req.params.id, req.user!.firmId);
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return client;
  });

  // POST /api/clients/:id/inquire-withdrawals — 不明出金の照会メッセージを送信
  app.post<{
    Params: { id: string };
    Body: {
      entries: Array<{ date: string; amount: number; description: string }>;
    };
  }>('/api/clients/:id/inquire-withdrawals', async (req, reply) => {
    const client = await getClientById(req.params.id, req.user!.firmId);
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: 'entries must be a non-empty array' } };
    }
    const result = await inquireAboutUnknownWithdrawals(req.params.id, entries);
    if (!result.ok) {
      reply.code(500);
      return { error: { code: 'SEND_FAILED', message: result.message } };
    }
    return { ok: true, message: result.message, body: result.body };
  });
}
