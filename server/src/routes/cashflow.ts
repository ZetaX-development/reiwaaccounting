import type { FastifyInstance } from 'fastify';
import { getCashFlowForecast, buildCashFlowForecast } from '../services/cashflow-service.js';

export async function cashflowRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/clients/:id/cashflow', async (req, reply) => {
    try {
      return await getCashFlowForecast(req.params.id, req.user!.firmId);
    } catch (err: unknown) {
      reply.code(500);
      return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : 'failed' } };
    }
  });

  app.post<{ Params: { id: string } }>('/api/clients/:id/cashflow/refresh', async (req, reply) => {
    try {
      return await buildCashFlowForecast(req.params.id, req.user!.firmId);
    } catch (err: unknown) {
      reply.code(500);
      return { error: { code: 'REFRESH_FAILED', message: err instanceof Error ? err.message : 'failed' } };
    }
  });
}
