import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  buildMfAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchOffice,
  MF_SCOPES,
} from '../adapters/mf-api.js';

export async function mfOauthRoutes(app: FastifyInstance) {
  /**
   * Initiates the OAuth dance for a given clientId. The Money Forward
   * authorization server lives at MF_AUTH_BASE_URL (api.biz.moneyforward.com).
   * `state` carries the bookmee Client.id so the callback knows which row
   * receives the tokens.
   */
  app.get<{ Querystring: { clientId?: string } }>(
    '/api/mf/oauth/start',
    async (req, reply) => {
      const { clientId } = req.query;
      if (!clientId) {
        reply.code(400);
        return { error: { code: 'MISSING_PARAM', message: 'clientId is required' } };
      }
      if (!env.MF_CLIENT_ID || !env.MF_REDIRECT_URI) {
        reply.code(503);
        return {
          error: {
            code: 'MF_NOT_CONFIGURED',
            message: 'MF_CLIENT_ID / MF_REDIRECT_URI を .env に設定してください',
          },
        };
      }
      const url = buildMfAuthorizeUrl({
        clientId: env.MF_CLIENT_ID,
        redirectUri: env.MF_REDIRECT_URI,
        state: clientId,
        scope: MF_SCOPES.join(' '),
      });
      reply.redirect(url);
      return reply;
    },
  );

  /**
   * OAuth redirect target. Exchanges the authorization code for tokens via
   * api.biz.moneyforward.com/token, then probes /api/v3/offices to confirm
   * connectivity and persists the office name on the Client row.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/api/mf/oauth/callback',
    async (req, reply) => {
      const { code, state, error, error_description } = req.query;
      if (error) {
        reply.code(400);
        return {
          error: {
            code: 'OAUTH_ERROR',
            message: error_description ?? error,
          },
        };
      }
      if (!code || !state) {
        reply.code(400);
        return {
          error: { code: 'MISSING_PARAM', message: 'code and state are required' },
        };
      }
      const client = await prisma.client.findUnique({ where: { id: state } });
      if (!client) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'client (state) not found' } };
      }

      try {
        const tokens = await exchangeAuthorizationCode({
          code,
          redirectUri: env.MF_REDIRECT_URI,
        });
        await prisma.client.update({
          where: { id: client.id },
          data: {
            mfAccessToken: tokens.access_token,
            mfRefreshToken: tokens.refresh_token ?? null,
            mfTokenExpiresAt: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : null,
          },
        });

        // Confirm connection by reading the office name. We also adopt the
        // MF office name as the bookmee Client.name so the dashboard shows
        // the real customer instead of the seeded placeholder.
        const office = await fetchOffice(tokens.access_token);
        const updated = await prisma.client.update({
          where: { id: client.id },
          data: {
            mfExternalId: office?.code ?? null,
            name: office?.name ?? client.name,
          },
        });

        const officeLine = office?.name
          ? `<p>連携先 MF 事業者: <strong>${escapeHtml(office.name)}</strong></p>`
          : '<p>連携完了 (事業者情報の取得には offices.read スコープが必要です)</p>';
        reply
          .type('text/html')
          .send(
            `<!doctype html><meta charset="utf-8"><title>MF 連携完了</title>` +
              `<h1>MF 連携完了</h1>` +
              `<p>顧問先 ${escapeHtml(updated.name)} のアクセストークンを保存しました。</p>` +
              officeLine +
              `<p><a href="/">ダッシュボードへ戻る</a></p>`,
          );
        return reply;
      } catch (err) {
        logger.error({ err, clientId: client.id }, 'mf callback failed');
        reply.code(500);
        return {
          error: {
            code: 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
