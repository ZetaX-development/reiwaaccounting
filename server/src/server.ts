if (process.env.NODE_ENV !== 'test') { await import('./bootstrap.js'); }
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { requireAuth } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { firmRoutes } from './routes/firms.js';
import { clientRoutes } from './routes/clients.js';
import { syncRoutes } from './routes/sync.js';
import { syncStatusRoutes } from './routes/sync-status.js';
import { summaryRoutes } from './routes/summary.js';
import { mfOauthRoutes } from './routes/mf-oauth.js';
import { freeeOauthRoutes } from './routes/freee-oauth.js';
import { messageRoutes } from './routes/messages.js';
import { taskRoutes } from './routes/tasks.js';
import { ruleRoutes } from './routes/rules.js';
import { receiptRoutes } from './routes/receipts.js';
import { modeRoutes } from './routes/mode.js';
import { mfBooksRoutes } from './routes/mf-books.js';
import { voucherRoutes } from './routes/vouchers.js';
import { ccStatementRoutes } from './routes/cc-statement.js';
import { integrationsDriveRoutes } from './routes/integrations-drive.js';
import { integrationsLineRoutes } from './routes/integrations-line.js';
import { journalReviewRoutes } from './routes/journal-reviews.js';
import { journalPatternRoutes } from './routes/journal-patterns.js';
import { todoRoutes } from './routes/todos.js';
import { taxSuggestionRoutes } from './routes/tax-suggestions.js';
import { cashflowRoutes } from './routes/cashflow.js';
import { portalReportRoutes } from './routes/portal-report.js';
import { trainingRoutes } from './routes/training.js';
import { feedbackRoutes } from './routes/feedback.js';
import { fixedAssetRoutes } from './routes/fixed-assets.js';
import { accrualRoutes } from './routes/accruals.js';
import { arMatchingRoutes } from './routes/ar-matching.js';
import { bankStatementRoutes } from './routes/bank-statement.js';
import multipart from '@fastify/multipart';

const AUTH_BYPASS = new Set([
  '/api/health',
  '/api/auth/register',
  '/api/mf/oauth/start',
  '/api/mf/oauth/callback',
  '/api/freee/oauth/start',
  '/api/freee/oauth/callback',
  '/api/integrations/drive/oauth/authorize',
  '/api/integrations/drive/oauth/callback',
  '/api/integrations/drive/webhook',
  '/api/integrations/line/webhook',
]);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  // CORS: allow same-origin + configured origin only.
  const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3001';
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow same-origin requests (no origin header) and the configured origin.
      if (!origin || origin === allowedOrigin) return cb(null, true);
      cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Rate limiting: 200 req / 15 min per IP for API routes.
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '15 minutes',
    skipOnError: true,
    errorResponseBuilder: (_req: FastifyRequest, context: { ttl: number }) => ({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      },
    }),
  });
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

  // Global auth guard — only applies to /api/* routes, bypassing static files and OAuth callbacks.
  app.addHook('preHandler', async (req: FastifyRequest, reply) => {
    const urlPath = req.url.split('?')[0];
    if (!urlPath.startsWith('/api/')) return;
    if (AUTH_BYPASS.has(urlPath)) return;
    // /api/portal/:token は公開エンドポイント（顧問先が直接アクセス）
    if (urlPath.startsWith('/api/portal/')) return;
    await requireAuth(req, reply);
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(firmRoutes);
  await app.register(clientRoutes);
  await app.register(syncRoutes);
  await app.register(syncStatusRoutes);
  await app.register(summaryRoutes);
  await app.register(mfOauthRoutes);
  await app.register(freeeOauthRoutes);
  await app.register(messageRoutes);
  await app.register(taskRoutes);
  await app.register(ruleRoutes);
  await app.register(receiptRoutes);
  await app.register(modeRoutes);
  await app.register(mfBooksRoutes);
  await app.register(voucherRoutes);
  await app.register(ccStatementRoutes);
  await app.register(integrationsDriveRoutes);
  await app.register(integrationsLineRoutes);
  await app.register(journalReviewRoutes);
  await app.register(journalPatternRoutes);
  await app.register(todoRoutes);
  await app.register(taxSuggestionRoutes);
  await app.register(cashflowRoutes);
  await app.register(portalReportRoutes);
  await app.register(trainingRoutes);
  await app.register(feedbackRoutes);
  await app.register(fixedAssetRoutes);
  await app.register(accrualRoutes);
  await app.register(arMatchingRoutes);
  await app.register(bankStatementRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled');
    reply.status(err.statusCode ?? 500).send({
      error: { code: err.code ?? 'INTERNAL', message: err.message },
    });
  });

  return app as unknown as FastifyInstance;
}

async function main() {
  if (env.NODE_ENV === 'production' && !env.SUPABASE_URL) {
    logger.warn(
      'SUPABASE_URL is not set — authenticated API routes will return 503',
    );
  }
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  });
}
