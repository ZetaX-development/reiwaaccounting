import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import * as lineService from '../services/line-service.js';
import * as lineImporter from '../services/line-importer.js';
import {
  listMappings,
  updateMapping,
  deleteMapping,
} from '../services/line-mapping-service.js';

interface JsonBodyWithRaw {
  rawBody?: Buffer;
  events?: lineImporter.LineWebhookEvent[];
}

export async function integrationsLineRoutes(
  app: FastifyInstance,
): Promise<void> {
  // Scoped content-type parser so we keep the raw bytes for HMAC signature
  // verification on the webhook. Only routes registered *inside this plugin*
  // are affected.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      const buf = body as Buffer;
      try {
        const json: JsonBodyWithRaw = buf.length
          ? (JSON.parse(buf.toString('utf8')) as JsonBodyWithRaw)
          : {};
        json.rawBody = buf;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // ---- GET /api/integrations/line --------------------------------------
  app.get('/api/integrations/line', async () => {
    const connected = Boolean(
      env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET,
    );
    const userCount = await prisma.lineUserMapping.count();
    const enabledUserCount = await prisma.lineUserMapping.count({
      where: { enabled: true },
    });
    if (!connected) {
      return {
        connected: false,
        userCount,
        enabledUserCount,
      };
    }
    const webhookUrl = env.LINE_WEBHOOK_BASE_URL
      ? `${env.LINE_WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/integrations/line/webhook`
      : undefined;
    return {
      connected: true,
      channelId: env.LINE_CHANNEL_ID || undefined,
      webhookUrl,
      userCount,
      enabledUserCount,
    };
  });

  // ---- POST /api/integrations/line/verify ------------------------------
  app.post('/api/integrations/line/verify', async (_req, reply) => {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      reply.code(400);
      return {
        ok: false,
        message: 'LINE_CHANNEL_ACCESS_TOKEN が設定されていません',
      };
    }
    try {
      const botInfo = await lineService.getBotInfo();
      return { ok: true, botInfo };
    } catch (err) {
      if (err instanceof lineService.LineApiError) {
        return {
          ok: false,
          status: err.status,
          message: err.bodyText.slice(0, 200),
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    }
  });

  // ---- POST /api/integrations/line/webhook -----------------------------
  app.post('/api/integrations/line/webhook', async (req, reply) => {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_CHANNEL_SECRET) {
      reply.code(401);
      return { error: { code: 'NOT_CONFIGURED', message: 'LINE not configured' } };
    }
    const body = (req.body ?? {}) as JsonBodyWithRaw;
    const rawBody = body.rawBody ?? Buffer.alloc(0);
    const signature = req.headers['x-line-signature'];
    const signatureStr = Array.isArray(signature) ? signature[0] : signature;
    const ok = lineService.verifySignature(
      env.LINE_CHANNEL_SECRET,
      rawBody,
      signatureStr,
    );
    if (!ok) {
      reply.code(401);
      return {
        error: { code: 'INVALID_SIGNATURE', message: 'signature mismatch' },
      };
    }

    const events = Array.isArray(body.events) ? body.events : [];
    // Reply 200 immediately, process asynchronously (LINE wants < 30s response).
    setImmediate(() => {
      lineImporter.handleWebhookEvents(events).catch((err) => {
        logger.warn({ err }, 'line webhook handler failed');
      });
    });
    return { ok: true };
  });

  // ---- GET /api/integrations/line/users --------------------------------
  app.get('/api/integrations/line/users', async () => {
    return listMappings();
  });

  // ---- PATCH /api/integrations/line/users/:id --------------------------
  app.patch<{
    Params: { id: string };
    Body: { staffLabel?: string | null; enabled?: boolean };
  }>('/api/integrations/line/users/:id', async (req, reply) => {
    const patch = req.body ?? {};
    const updated = await updateMapping(req.params.id, {
      staffLabel: patch.staffLabel,
      enabled: patch.enabled,
    });
    if (!updated) {
      reply.code(404);
      return {
        error: { code: 'NOT_FOUND', message: 'mapping not found' },
      };
    }
    return updated;
  });

  // ---- DELETE /api/integrations/line/users/:id -------------------------
  app.delete<{ Params: { id: string } }>(
    '/api/integrations/line/users/:id',
    async (req, reply) => {
      const ok = await deleteMapping(req.params.id);
      if (!ok) {
        reply.code(404);
        return {
          error: { code: 'NOT_FOUND', message: 'mapping not found' },
        };
      }
      return { ok: true };
    },
  );
}
