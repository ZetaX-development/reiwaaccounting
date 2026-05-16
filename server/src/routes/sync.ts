import type { FastifyInstance } from 'fastify';
import { syncClient } from '../services/sync-service.js';

export async function syncRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/api/clients/:id/sync', async (req, reply) => {
    const result = await syncClient(req.params.id);
    if (result.status === 'error' && result.errorMsg === 'client not found') {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return result;
  });
}
