import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import * as driveService from '../services/drive-service.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
} from '../services/drive-service.js';
import {
  getDriveIntegration,
  upsertDriveIntegration,
  updateDriveSettings,
  deleteDriveIntegration,
  markStatus,
  ensureDriveToken,
  type DriveSettings,
  type DriveCreds,
} from '../services/integration-service.js';
import { syncDriveChanges } from '../services/drive-importer.js';

// ---------------------------------------------------------------------------
// Spec 15 — Google Drive integration HTTP surface.
// ---------------------------------------------------------------------------

function webhookUrl(): string {
  if (!env.GOOGLE_DRIVE_WEBHOOK_BASE_URL) return '';
  const base = env.GOOGLE_DRIVE_WEBHOOK_BASE_URL.replace(/\/+$/, '');
  return `${base}/api/integrations/drive/webhook`;
}

export async function integrationsDriveRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Connection status
  // -------------------------------------------------------------------------
  app.get('/api/integrations/drive', async () => {
    const row = await getDriveIntegration();
    if (!row) {
      return { connected: false };
    }
    const creds = row.creds as unknown as DriveCreds;
    const settings = (row.settings as DriveSettings | null) ?? {};
    const watch = await prisma.driveWatchChannel.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    return {
      connected: true,
      email: creds.email ?? null,
      status: row.status,
      watchExpiresAt: watch?.expiresAt ?? null,
      settings,
    };
  });

  // -------------------------------------------------------------------------
  // OAuth start — redirect to Google
  // -------------------------------------------------------------------------
  app.get('/api/integrations/drive/oauth/authorize', async (_req, reply) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      reply.code(503);
      return {
        error: {
          code: 'NOT_CONFIGURED',
          message: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定してください',
        },
      };
    }
    const url = buildAuthorizeUrl(randomUUID());
    reply.redirect(url);
    return reply;
  });

  // -------------------------------------------------------------------------
  // OAuth callback
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/api/integrations/drive/oauth/callback',
    async (req, reply) => {
      const { code, error } = req.query;
      if (error) {
        reply.code(400);
        return { error: { code: 'OAUTH_ERROR', message: error } };
      }
      if (!code) {
        reply.code(400);
        return {
          error: { code: 'INVALID_BODY', message: 'code is required' },
        };
      }
      try {
        const creds = await exchangeCode(code);
        await upsertDriveIntegration(creds);

        // Best-effort watch registration. Failure flips status to
        // watch_failed but the integration still works in manual mode.
        if (env.GOOGLE_DRIVE_WEBHOOK_BASE_URL) {
          try {
            const channelId = randomUUID();
            const watchResult = await driveService.startWatch(
              creds.accessToken,
              channelId,
              webhookUrl(),
            );
            if (watchResult) {
              const startPageToken = await driveService.getStartPageToken(
                creds.accessToken,
              );
              await prisma.driveWatchChannel.create({
                data: {
                  channelId,
                  resourceId: watchResult.resourceId,
                  pageToken: startPageToken,
                  expiresAt: new Date(watchResult.expiration),
                },
              });
            }
          } catch (err) {
            logger.warn({ err }, 'drive watch start failed');
            await markStatus('watch_failed');
          }
        }

        reply.redirect('/#/integrations/drive');
        return reply;
      } catch (err) {
        logger.error({ err }, 'drive oauth callback failed');
        reply.code(502);
        return {
          error: {
            code: 'DRIVE_API_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------
  app.delete('/api/integrations/drive', async (_req, reply) => {
    const row = await getDriveIntegration();
    if (!row) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'integration not found' } };
    }
    const creds = row.creds as unknown as DriveCreds;
    const watches = await prisma.driveWatchChannel.findMany();
    for (const w of watches) {
      if (w.resourceId) {
        try {
          await driveService.stopWatch(
            creds.accessToken,
            w.channelId,
            w.resourceId,
          );
        } catch (err) {
          logger.warn({ err, channelId: w.channelId }, 'drive stopWatch failed');
        }
      }
    }
    await prisma.driveWatchChannel.deleteMany();
    await deleteDriveIntegration();
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // List subfolders of configured root (or 'root' if none set)
  // -------------------------------------------------------------------------
  app.get('/api/integrations/drive/folders', async (_req, reply) => {
    const row = await getDriveIntegration();
    if (!row) {
      reply.code(401);
      return {
        error: { code: 'NOT_CONNECTED', message: 'drive not connected' },
      };
    }
    let token: string;
    try {
      token = await ensureDriveToken();
    } catch (err) {
      reply.code(401);
      return {
        error: {
          code: 'NOT_CONNECTED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    const settings = (row.settings as DriveSettings | null) ?? {};
    const rootId = settings.rootFolderId?.trim() || 'root';
    try {
      const folders = await driveService.listSubfolders(token, rootId);
      return { folders };
    } catch (err) {
      logger.warn({ err }, 'drive listSubfolders failed');
      reply.code(502);
      return {
        error: {
          code: 'DRIVE_API_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  // -------------------------------------------------------------------------
  // Mappings
  // -------------------------------------------------------------------------
  app.get('/api/integrations/drive/mappings', async () => {
    const rows = await prisma.driveFolderMapping.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return { mappings: rows };
  });

  app.post<{
    Body: { driveFolderId?: string; folderName?: string; clientId?: string };
  }>('/api/integrations/drive/mappings', async (req, reply) => {
    const body = req.body || {};
    if (!body.driveFolderId || !body.folderName || !body.clientId) {
      reply.code(400);
      return {
        error: {
          code: 'INVALID_BODY',
          message: 'driveFolderId, folderName, clientId are required',
        },
      };
    }
    const client = await prisma.client.findUnique({
      where: { id: body.clientId },
      select: { id: true },
    });
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
    try {
      const row = await prisma.driveFolderMapping.upsert({
        where: { driveFolderId: body.driveFolderId },
        create: {
          driveFolderId: body.driveFolderId,
          folderName: body.folderName,
          clientId: body.clientId,
        },
        update: {
          folderName: body.folderName,
          clientId: body.clientId,
        },
      });
      reply.code(201);
      return row;
    } catch (err) {
      logger.warn({ err }, 'drive mapping upsert failed');
      reply.code(500);
      return {
        error: {
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/api/integrations/drive/mappings/:id',
    async (req, reply) => {
      const result = await prisma.driveFolderMapping.deleteMany({
        where: { id: req.params.id },
      });
      if (result.count === 0) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'mapping not found' } };
      }
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  app.put<{
    Body: { rootFolderId?: string; importedSubfolderName?: string };
  }>('/api/integrations/drive/settings', async (req, reply) => {
    const row = await getDriveIntegration();
    if (!row) {
      reply.code(401);
      return {
        error: { code: 'NOT_CONNECTED', message: 'drive not connected' },
      };
    }
    const body = req.body || {};
    const patch: DriveSettings = {};
    if (body.rootFolderId !== undefined) patch.rootFolderId = body.rootFolderId;
    if (body.importedSubfolderName !== undefined) {
      patch.importedSubfolderName = body.importedSubfolderName;
    }
    const updated = await updateDriveSettings(patch);
    return { settings: (updated?.settings as DriveSettings | null) ?? {} };
  });

  // -------------------------------------------------------------------------
  // Manual sync
  // -------------------------------------------------------------------------
  app.post('/api/integrations/drive/sync', async (_req, reply) => {
    const row = await getDriveIntegration();
    if (!row) {
      reply.code(401);
      return {
        error: { code: 'NOT_CONNECTED', message: 'drive not connected' },
      };
    }
    try {
      const result = await syncDriveChanges({ trigger: 'manual' });
      return result;
    } catch (err) {
      logger.error({ err }, 'drive sync failed');
      reply.code(502);
      return {
        error: {
          code: 'DRIVE_API_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  // -------------------------------------------------------------------------
  // Webhook receiver — Google Drive Push Notification
  // -------------------------------------------------------------------------
  app.post('/api/integrations/drive/webhook', async (req, reply) => {
    const channelId = req.headers['x-goog-channel-id'];
    const resourceState = req.headers['x-goog-resource-state'];
    if (typeof channelId !== 'string' || !channelId) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'channel not found' } };
    }
    const watch = await prisma.driveWatchChannel.findUnique({
      where: { channelId },
    });
    if (!watch) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'channel not found' } };
    }
    // Initial handshake: Google sends `sync` once after a watch is created.
    if (resourceState === 'sync') {
      return { ok: true };
    }
    setImmediate(() => {
      syncDriveChanges({ trigger: 'webhook' }).catch((err) => {
        logger.warn({ err }, 'drive webhook sync failed');
      });
    });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Watch channel renewal
  // -------------------------------------------------------------------------
  app.post('/api/integrations/drive/watch/renew', async (_req, reply) => {
    const row = await getDriveIntegration();
    if (!row) {
      reply.code(401);
      return {
        error: { code: 'NOT_CONNECTED', message: 'drive not connected' },
      };
    }
    if (!env.GOOGLE_DRIVE_WEBHOOK_BASE_URL) {
      return { ok: true, skipped: 'no webhook base URL configured' };
    }
    let token: string;
    try {
      token = await ensureDriveToken();
    } catch (err) {
      reply.code(401);
      return {
        error: {
          code: 'NOT_CONNECTED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    try {
      const oldChannels = await prisma.driveWatchChannel.findMany();
      const newChannelId = randomUUID();
      const startPageToken = await driveService.getStartPageToken(token);
      const watchResult = await driveService.startWatch(
        token,
        newChannelId,
        webhookUrl(),
      );
      if (!watchResult) {
        await markStatus('watch_failed');
        return { ok: false, reason: 'startWatch returned null' };
      }
      const created = await prisma.driveWatchChannel.create({
        data: {
          channelId: newChannelId,
          resourceId: watchResult.resourceId,
          pageToken: startPageToken,
          expiresAt: new Date(watchResult.expiration),
        },
      });
      for (const old of oldChannels) {
        if (old.resourceId) {
          try {
            await driveService.stopWatch(token, old.channelId, old.resourceId);
          } catch (err) {
            logger.warn(
              { err, channelId: old.channelId },
              'drive stopWatch (renew) failed',
            );
          }
        }
        await prisma.driveWatchChannel.delete({ where: { id: old.id } });
      }
      await markStatus('ok');
      return { ok: true, channel: created };
    } catch (err) {
      logger.error({ err }, 'drive watch renew failed');
      await markStatus('watch_failed');
      reply.code(502);
      return {
        error: {
          code: 'DRIVE_API_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });
}
