import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listClientModes,
  listYearendChecklist,
  setClientMode,
  updateYearendCheck,
} from '../services/mode-service.js';

const modeSchema = z.object({ mode: z.enum(['monthly', 'yearend']) });
const checkPatchSchema = z.object({
  status: z.enum(['open', 'urgent', 'done']).optional(),
  note: z.string().nullable().optional(),
});

export async function modeRoutes(app: FastifyInstance) {
  app.patch<{ Params: { id: string } }>(
    '/api/clients/:id/mode',
    async (req, reply) => {
      const parsed = modeSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: { code: 'INVALID_BODY', message: parsed.error.issues[0].message } };
      }
      return setClientMode(req.params.id, parsed.data.mode);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/clients/:id/yearend-checklist',
    async (req) => {
      return listYearendChecklist(req.params.id);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/yearend-checks/:id',
    async (req, reply) => {
      const parsed = checkPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: { code: 'INVALID_BODY', message: parsed.error.issues[0].message } };
      }
      return updateYearendCheck(req.params.id, parsed.data);
    },
  );

  app.get('/api/client-modes', async () => {
    return listClientModes();
  });
}
