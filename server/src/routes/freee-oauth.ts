import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const FREEE_AUTHORIZE_URL = 'https://accounts.freee.co.jp/public_api/authorize';
const FREEE_TOKEN_URL = 'https://accounts.freee.co.jp/public_api/token';
const FREEE_COMPANIES_URL = 'https://api.freee.co.jp/api/1/companies';

interface FreeeTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  company_id?: string | number;
}

interface FreeeCompany {
  id: string | number;
  name?: string;
  display_name?: string;
}

interface FreeeCompaniesResponse {
  companies?: FreeeCompany[];
}

export async function freeeOauthRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { clientId?: string } }>(
    '/api/freee/oauth/start',
    async (req, reply) => {
      const { clientId } = req.query;
      if (!clientId) {
        reply.code(400);
        return { error: { code: 'MISSING_PARAM', message: 'clientId is required' } };
      }
      if (!env.FREEE_CLIENT_ID) {
        reply.code(400);
        return {
          error: {
            code: 'FREEE_NOT_CONFIGURED',
            message: 'FREEE_CLIENT_ID を .env に設定してください',
          },
        };
      }
      if (!env.FREEE_REDIRECT_URI) {
        reply.code(400);
        return {
          error: {
            code: 'FREEE_NOT_CONFIGURED',
            message: 'FREEE_REDIRECT_URI を .env に設定してください',
          },
        };
      }

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.FREEE_CLIENT_ID,
        redirect_uri: env.FREEE_REDIRECT_URI,
        state: clientId,
        scope: 'read',
      });
      reply.redirect(`${FREEE_AUTHORIZE_URL}?${params.toString()}`);
      return reply;
    },
  );

  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
  }>('/api/freee/oauth/callback', async (req, reply) => {
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
    if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !env.FREEE_REDIRECT_URI) {
      reply.code(400);
      return {
        error: {
          code: 'FREEE_NOT_CONFIGURED',
          message:
            'FREEE_CLIENT_ID / FREEE_CLIENT_SECRET / FREEE_REDIRECT_URI を .env に設定してください',
        },
      };
    }

    const client = await prisma.client.findUnique({ where: { id: state } });
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client (state) not found' } };
    }

    try {
      const tokens = await exchangeAuthorizationCode(code);
      const companies = await fetchCompanies(tokens.access_token);
      const company =
        companies.find((item) => String(item.id) === String(tokens.company_id)) ??
        companies[0];
      if (!company) {
        throw new Error('freee companies response did not contain a company');
      }

      await prisma.client.update({
        where: { id: client.id },
        data: {
          freeeAccessToken: tokens.access_token,
          freeeRefreshToken: tokens.refresh_token ?? null,
          freeeTokenExpiresAt: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000)
            : null,
          freeeExternalId: String(company.id),
        },
      });

      const companyName = company.display_name ?? company.name;
      const companyLine = companyName
        ? `<p>連携先 freee 事業所: <strong>${escapeHtml(companyName)}</strong></p>`
        : `<p>連携先 freee 事業所ID: <strong>${escapeHtml(String(company.id))}</strong></p>`;
      reply
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>freee 連携完了</title>` +
            `<h1>freee 連携完了</h1>` +
            `<p>顧問先 ${escapeHtml(client.name)} のアクセストークンを保存しました。</p>` +
            companyLine +
            `<p><a href="/">ダッシュボードへ戻る</a></p>`,
        );
      return reply;
    } catch (err) {
      logger.error({ err, clientId: client.id }, 'freee callback failed');
      reply.code(500);
      return {
        error: {
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });
}

async function exchangeAuthorizationCode(code: string): Promise<FreeeTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.FREEE_CLIENT_ID,
    client_secret: env.FREEE_CLIENT_SECRET,
    code,
    redirect_uri: env.FREEE_REDIRECT_URI,
  });
  const res = await request(FREEE_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(
      `freee token exchange failed: ${res.statusCode} ${text.slice(0, 200)}`,
    );
  }
  const tokens = (await res.body.json()) as FreeeTokenResponse;
  if (!tokens.access_token) {
    throw new Error('freee token response did not contain an access_token');
  }
  return tokens;
}

async function fetchCompanies(accessToken: string): Promise<FreeeCompany[]> {
  const res = await request(FREEE_COMPANIES_URL, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(
      `freee companies fetch failed: ${res.statusCode} ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.body.json()) as FreeeCompaniesResponse;
  return data.companies ?? [];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
