import type { FastifyInstance } from 'fastify';
import { listClients, getClientById } from '../services/client-service.js';

export async function clientRoutes(app: FastifyInstance) {
  app.get('/api/clients', async () => {
    return listClients();
  });

  app.get<{ Params: { id: string } }>('/api/clients/:id', async (req, reply) => {
    const client = await getClientById(req.params.id);
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    return client;
  });
}
