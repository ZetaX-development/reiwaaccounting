import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listClients, getClientById, createClient } from '../services/client-service.js';

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

  app.get<{ Params: { id: string } }>('/api/clients/:id', async (req, reply) => {
    const client = await getClientById(req.params.id, req.user!.firmId);
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return client;
  });
}
