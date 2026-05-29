import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analyzeTaxSuggestions, listTaxSuggestions, updateTaxSuggestionStatus } from '../services/tax-suggestion-service.js';

const updateStatusSchema = z.object({ status: z.enum(['open', 'implemented', 'dismissed']) });

export async function taxSuggestionRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/clients/:id/tax-suggestions', async (req, _reply) => {
    const suggestions = await listTaxSuggestions(req.params.id, req.user!.firmId);
    return { suggestions };
  });

  app.post<{ Params: { id: string } }>('/api/clients/:id/tax-suggestions/analyze', async (req, reply) => {
    try {
      const result = await analyzeTaxSuggestions(req.params.id, req.user!.firmId);
      reply.code(201);
      return result;
    } catch (err: unknown) {
      reply.code(500);
      return { error: { code: 'ANALYZE_FAILED', message: err instanceof Error ? err.message : 'analyze failed' } };
    }
  });

  app.patch<{ Params: { id: string } }>('/api/tax-suggestions/:id', async (req, reply) => {
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'invalid' } };
    }
    const ok = await updateTaxSuggestionStatus(req.params.id, req.user!.firmId, parsed.data.status);
    if (!ok) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'suggestion not found' } };
    }
    return { ok: true };
  });
}
