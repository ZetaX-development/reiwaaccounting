import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    google_client_id_length: (process.env.GOOGLE_CLIENT_ID ?? '').length,
    google_secret_set: !!(process.env.GOOGLE_CLIENT_SECRET),
  }));
}
