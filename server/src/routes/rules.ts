import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addRule,
  deleteRule,
  listRules,
  listRuleHits,
  listTemplates,
  updateRule,
} from '../services/rule-service.js';

const createSchema = z.object({
  type: z.enum(['template', 'custom']),
  industry: z.string().optional(),
  title: z.string().min(1),
  detail: z.string().optional(),
  severity: z.enum(['high', 'mid', 'low']),
  createdBy: z.string().optional(),
});

const updateSchema = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  severity: z.enum(['high', 'mid', 'low']).optional(),
  active: z.boolean().optional(),
});

export async function ruleRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { industry?: string } }>(
    '/api/rule-templates',
    async (req) => {
      return listTemplates(req.query.industry);
    },
  );

  app.get<{ Params: { id: string } }>('/api/clients/:id/rules', async (req) => {
    return listRules(req.params.id);
  });

  app.post<{ Params: { id: string } }>(
    '/api/clients/:id/rules',
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: { code: 'INVALID_BODY', message: parsed.error.issues.map((i) => i.message).join('; ') },
        };
      }
      return addRule({ clientId: req.params.id, ...parsed.data });
    },
  );

  app.patch<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: { code: 'INVALID_BODY', message: parsed.error.issues.map((i) => i.message).join('; ') },
      };
    }
    return updateRule(req.params.id, parsed.data);
  });

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req) => {
    await deleteRule(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/rules/:id/hits', async (req) => {
    return listRuleHits(req.params.id);
  });
}
