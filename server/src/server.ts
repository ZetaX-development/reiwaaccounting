import './bootstrap.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { clientRoutes } from './routes/clients.js';
import { syncRoutes } from './routes/sync.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, { origin: true });
  await app.register(healthRoutes);
  await app.register(clientRoutes);
  await app.register(syncRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled');
    reply.status(err.statusCode ?? 500).send({
      error: { code: err.code ?? 'INTERNAL', message: err.message },
    });
  });

  return app;
}

async function main() {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  });
}
