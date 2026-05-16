import type { FastifyInstance } from 'fastify';
import { getSyncStatus } from '../services/sync-status-service.js';

export async function syncStatusRoutes(app: FastifyInstance) {
  app.get('/api/sync-status', async () => {
    return getSyncStatus();
  });
}
