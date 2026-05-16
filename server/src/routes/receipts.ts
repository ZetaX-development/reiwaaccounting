import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  computeMissingReceipts,
  generateReceiptRequest,
  listReceiptPolicies,
  markEntriesRequested,
  markEntryNotRequired,
  updateClientReceiptOverrides,
  updateReceiptPolicy,
} from '../services/receipt-service.js';

const policyPatchSchema = z.object({
  requiresReceipt: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  exemptUnder: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const overridesSchema = z.record(
  z.object({
    requiresReceipt: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    exemptUnder: z.number().int().nullable().optional(),
  }),
);

const requestSchema = z.object({
  entryIds: z.array(z.string()).min(1),
  channel: z.enum(['email', 'slack', 'chatwork', 'line_works', 'messenger']),
});

export async function receiptRoutes(app: FastifyInstance) {
  app.get('/api/receipt-policies', async () => {
    return listReceiptPolicies();
  });

  app.patch<{ Params: { account: string } }>(
    '/api/receipt-policies/:account',
    async (req, reply) => {
      const parsed = policyPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: { code: 'INVALID_BODY', message: parsed.error.issues.map((i) => i.message).join('; ') },
        };
      }
      return updateReceiptPolicy(req.params.account, parsed.data);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/clients/:id/receipt-overrides',
    async (req, reply) => {
      const parsed = overridesSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: { code: 'INVALID_BODY', message: parsed.error.issues.map((i) => i.message).join('; ') },
        };
      }
      return updateClientReceiptOverrides(req.params.id, parsed.data);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/clients/:id/missing-receipts',
    async (req) => {
      return computeMissingReceipts(req.params.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/clients/:id/receipt-requests',
    async (req, reply) => {
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: { code: 'INVALID_BODY', message: parsed.error.issues.map((i) => i.message).join('; ') },
        };
      }
      const result = await generateReceiptRequest(
        req.params.id,
        parsed.data.entryIds,
        parsed.data.channel,
      );
      // Note: callers should send via POST /api/messages then optionally call
      // POST /api/entries/mark-requested to flag the entries.
      return result;
    },
  );

  app.post<{ Body: { entryIds: string[] } }>(
    '/api/entries/mark-requested',
    async (req, reply) => {
      const ids = req.body?.entryIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        reply.code(400);
        return { error: { code: 'INVALID_BODY', message: 'entryIds[] is required' } };
      }
      await markEntriesRequested(ids);
      return { ok: true, count: ids.length };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/entries/:id/mark-not-required',
    async (req) => {
      return markEntryNotRequired(req.params.id);
    },
  );
}
