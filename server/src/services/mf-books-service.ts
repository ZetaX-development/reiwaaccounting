import { request } from 'undici';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// MF Cloud Accounting 帳簿系の閲覧サービス
// /journals  /accounts  /sub_accounts  /reports/trial_balance_{bs,pl}
// すべて読取のみ。レスポンスは DB に保存せず、毎リクエスト MF API へ。
// ---------------------------------------------------------------------------

interface ClientTokens {
  id: string;
  mfAccessToken: string | null;
  mfRefreshToken: string | null;
  mfTokenExpiresAt: Date | null;
}

async function loadClient(clientId: string): Promise<ClientTokens | null> {
  return prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      mfAccessToken: true,
      mfRefreshToken: true,
      mfTokenExpiresAt: true,
    },
  });
}

async function refreshIfNeeded(client: ClientTokens): Promise<string | null> {
  if (!client.mfAccessToken) return null;
  const expiringSoon =
    !client.mfTokenExpiresAt ||
    client.mfTokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!expiringSoon) return client.mfAccessToken;
  if (!client.mfRefreshToken || !env.MF_CLIENT_ID || !env.MF_CLIENT_SECRET) {
    return client.mfAccessToken;
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: client.mfRefreshToken,
      client_id: env.MF_CLIENT_ID,
      client_secret: env.MF_CLIENT_SECRET,
    });
    const res = await request(`${env.MF_AUTH_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.statusCode !== 200) return client.mfAccessToken;
    const json = (await res.body.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    await prisma.client.update({
      where: { id: client.id },
      data: {
        mfAccessToken: json.access_token,
        mfRefreshToken: json.refresh_token ?? client.mfRefreshToken,
        mfTokenExpiresAt: json.expires_in
          ? new Date(Date.now() + json.expires_in * 1000)
          : null,
      },
    });
    return json.access_token;
  } catch (err) {
    logger.warn({ err, clientId: client.id }, 'mf token refresh failed (books)');
    return client.mfAccessToken;
  }
}

async function mfGet<T>(token: string, path: string): Promise<T | null> {
  try {
    const res = await request(`${env.MF_ACCOUNTING_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      logger.warn({ status: res.statusCode, path, text: text.slice(0, 200) }, 'mf book API non-200');
      return null;
    }
    return (await res.body.json()) as T;
  } catch (err) {
    logger.error({ err, path }, 'mf book API exception');
    return null;
  }
}

async function tokenOf(clientId: string): Promise<string | null> {
  const c = await loadClient(clientId);
  if (!c?.mfAccessToken) return null;
  return refreshIfNeeded(c);
}

// 共通: その顧問先の現在の会計期間 (開始日・終了日)
export async function getAccountingPeriod(clientId: string): Promise<{
  start: string;
  end: string;
} | null> {
  const token = await tokenOf(clientId);
  if (!token) return null;
  const office = await mfGet<{
    accounting_periods?: Array<{ start_date: string; end_date: string }>;
  }>(token, '/api/v3/offices');
  const period = office?.accounting_periods?.[0];
  if (!period) return null;
  return { start: period.start_date, end: period.end_date };
}

// 仕訳帳 (期間内すべての仕訳)
export async function getJournalBook(
  clientId: string,
  opts: { startDate?: string; endDate?: string; accountId?: string; subAccountId?: string } = {},
): Promise<{ journals: unknown[]; total?: number } | null> {
  const token = await tokenOf(clientId);
  if (!token) return null;

  const period = await getAccountingPeriod(clientId);
  if (!period) return { journals: [] };

  const start = opts.startDate ?? period.start;
  const end = opts.endDate ?? period.end;

  const params = new URLSearchParams({
    start_date: start,
    end_date: end,
    per_page: '200',
  });
  if (opts.accountId) params.set('account_id', opts.accountId);

  const json = await mfGet<{ journals?: unknown[]; metadata?: { total_count?: number } }>(
    token,
    `/api/v3/journals?${params.toString()}`,
  );
  if (!json) return null;
  // sub_account_id は API 側にフィルタ無いので応答後フィルタ
  let rows = json.journals ?? [];
  if (opts.subAccountId) {
    rows = rows.filter((j) => {
      const branches = (j as { branches?: Array<{ debitor?: { sub_account_id?: string }; creditor?: { sub_account_id?: string } }> }).branches ?? [];
      return branches.some(
        (b) =>
          b.debitor?.sub_account_id === opts.subAccountId ||
          b.creditor?.sub_account_id === opts.subAccountId,
      );
    });
  }
  return { journals: rows, total: json.metadata?.total_count };
}

export async function getAccounts(clientId: string): Promise<unknown[] | null> {
  const token = await tokenOf(clientId);
  if (!token) return null;
  const json = await mfGet<{ accounts?: unknown[] }>(
    token,
    '/api/v3/accounts',
  );
  return json?.accounts ?? null;
}

export async function getSubAccounts(clientId: string): Promise<unknown[] | null> {
  const token = await tokenOf(clientId);
  if (!token) return null;
  const json = await mfGet<{ sub_accounts?: unknown[] }>(
    token,
    '/api/v3/sub_accounts',
  );
  return json?.sub_accounts ?? null;
}

export async function getTrialBalance(
  clientId: string,
  type: 'bs' | 'pl',
): Promise<unknown | null> {
  const token = await tokenOf(clientId);
  if (!token) return null;
  const path =
    type === 'bs'
      ? '/api/v3/reports/trial_balance_bs'
      : '/api/v3/reports/trial_balance_pl';
  return mfGet(token, path);
}
