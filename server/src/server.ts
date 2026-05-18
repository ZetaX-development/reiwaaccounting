import './bootstrap.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { clientRoutes } from './routes/clients.js';
import { syncRoutes } from './routes/sync.js';
import { syncStatusRoutes } from './routes/sync-status.js';
import { summaryRoutes } from './routes/summary.js';
import { mfOauthRoutes } from './routes/mf-oauth.js';
import { messageRoutes } from './routes/messages.js';
import { taskRoutes } from './routes/tasks.js';
import { ruleRoutes } from './routes/rules.js';
import { receiptRoutes } from './routes/receipts.js';
import { modeRoutes } from './routes/mode.js';
import { mfBooksRoutes } from './routes/mf-books.js';
import multipart from '@fastify/multipart';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  // Serve the existing Vanilla frontend from the repo root.
  // server/src/server.ts -> server/src -> server -> repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../..');
  await app.register(staticPlugin, {
    root: repoRoot,
    prefix: '/',
    index: ['index.html'],
    decorateReply: false,
  });

  await app.register(healthRoutes);
  await app.register(clientRoutes);
  await app.register(syncRoutes);
  await app.register(syncStatusRoutes);
  await app.register(summaryRoutes);
  await app.register(mfOauthRoutes);
  await app.register(messageRoutes);
  await app.register(taskRoutes);
  await app.register(ruleRoutes);
  await app.register(receiptRoutes);
  await app.register(modeRoutes);
  await app.register(mfBooksRoutes);

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
