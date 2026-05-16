import type { FastifyInstance } from 'fastify';
import { getSummary } from '../services/summary-service.js';

export async function summaryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { clientId?: string } }>(
    '/api/summary',
    async (req) => {
      return getSummary(req.query.clientId);
    },
  );
}
