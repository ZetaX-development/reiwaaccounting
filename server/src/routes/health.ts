import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
  }));
}
