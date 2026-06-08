import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    // Safe deploy diagnostics (no secret values).
    config: {
      nodeEnv: env.NODE_ENV,
      supabaseUrl: Boolean(env.SUPABASE_URL),
      supabaseServiceRole: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
      databaseUrl: Boolean(env.DATABASE_URL),
      openai: Boolean(env.OPENAI_API_KEY),
    },
  }));
}
