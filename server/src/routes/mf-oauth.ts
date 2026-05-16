import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildMfAuthorizeUrl } from '../adapters/mf-api.js';

const MF_SCOPE = 'mfc/invoice/data.read mfc/invoice/data.write';

export async function mfOauthRoutes(app: FastifyInstance) {
  // Initiates the OAuth dance for a given clientId. Pass clientId via query so
  // the callback knows which Client row to attach the tokens to.
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
            message: 'MF_CLIENT_ID / MF_REDIRECT_URI are not configured (.env)',
          },
        };
      }
      const url = buildMfAuthorizeUrl({
        clientId: env.MF_CLIENT_ID,
        redirectUri: env.MF_REDIRECT_URI,
        state: clientId,
        scope: MF_SCOPE,
      });
      reply.redirect(url);
      return reply;
    },
  );

  // Handles the redirect back from MF. Exchanges code for tokens, persists
  // them on the Client row identified by `state`.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/mf/oauth/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error) {
        reply.code(400);
        return { error: { code: 'OAUTH_ERROR', message: error } };
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
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: env.MF_REDIRECT_URI,
          client_id: env.MF_CLIENT_ID,
          client_secret: env.MF_CLIENT_SECRET,
        });
        const tokenUrl = `${env.MF_BASE_URL}/token`;
        const res = await request(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (res.statusCode !== 200) {
          const text = await res.body.text();
          logger.error({ status: res.statusCode, text }, 'mf token exchange failed');
          reply.code(502);
          return {
            error: { code: 'MF_TOKEN_EXCHANGE_FAILED', message: text.slice(0, 200) },
          };
        }
        const json = (await res.body.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
        await prisma.client.update({
          where: { id: client.id },
          data: {
            mfAccessToken: json.access_token,
            mfRefreshToken: json.refresh_token ?? null,
            mfTokenExpiresAt: json.expires_in
              ? new Date(Date.now() + json.expires_in * 1000)
              : null,
          },
        });
        reply.type('text/html').send(
          `<html><body><h1>MF 連携 完了</h1><p>顧問先 ${client.name} の MF API アクセストークンを保存しました。</p><p><a href="/">ダッシュボードへ戻る</a></p></body></html>`,
        );
        return reply;
      } catch (err) {
        logger.error({ err }, 'mf callback failed');
        reply.code(500);
        return {
          error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  );
}
