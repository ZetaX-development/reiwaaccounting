import { request } from 'undici';
import type {
  FetchResult,
  RawEntry,
  RawMatching,
  RawReceipt,
  VendorAdapter,
} from './vendor-adapter.js';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

interface AuthorizeOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
}

export function buildMfAuthorizeUrl(opts: AuthorizeOptions): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: opts.scope,
    response_type: 'code',
  });
  const base = env.MF_BASE_URL || 'https://api.biz.moneyforward.com';
  return `${base}/authorize?${params.toString()}`;
}

const empty = <T>(): FetchResult<T> => ({ items: [], fetchedAt: new Date() });

interface ZeimeeClientRecord {
  id: string;
  mfAccessToken: string | null;
  mfRefreshToken: string | null;
  mfTokenExpiresAt: Date | null;
  mfExternalId: string | null;
}

async function loadClientToken(externalId: string): Promise<ZeimeeClientRecord | null> {
  // externalId is conventionally `mock-<clientId>` or the real `mfExternalId`.
  // We try both: first look up by Client.id if externalId starts with 'mock-',
  // otherwise look up by mfExternalId.
  if (externalId.startsWith('mock-')) {
    const id = externalId.slice('mock-'.length);
    return prisma.client.findUnique({
      where: { id },
      select: {
        id: true,
        mfAccessToken: true,
        mfRefreshToken: true,
        mfTokenExpiresAt: true,
        mfExternalId: true,
      },
    });
  }
  return prisma.client.findFirst({
    where: { mfExternalId: externalId },
    select: {
      id: true,
      mfAccessToken: true,
      mfRefreshToken: true,
      mfTokenExpiresAt: true,
      mfExternalId: true,
    },
  });
}

async function ensureToken(client: ZeimeeClientRecord): Promise<string | null> {
  if (!client.mfAccessToken) return null;
  // Refresh if expired or expiring within the next 60s.
  const expiringSoon =
    client.mfTokenExpiresAt &&
    client.mfTokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!expiringSoon) return client.mfAccessToken;
  if (!client.mfRefreshToken) return client.mfAccessToken;
  if (!env.MF_CLIENT_ID || !env.MF_CLIENT_SECRET || !env.MF_BASE_URL) {
    return client.mfAccessToken;
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: client.mfRefreshToken,
      client_id: env.MF_CLIENT_ID,
      client_secret: env.MF_CLIENT_SECRET,
    });
    const res = await request(`${env.MF_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.statusCode !== 200) {
      logger.warn({ status: res.statusCode }, 'mf token refresh failed; using stale');
      return client.mfAccessToken;
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
        mfRefreshToken: json.refresh_token ?? client.mfRefreshToken,
        mfTokenExpiresAt: json.expires_in
          ? new Date(Date.now() + json.expires_in * 1000)
          : null,
      },
    });
    return json.access_token;
  } catch (err) {
    logger.error({ err }, 'mf refresh exception; using stale token');
    return client.mfAccessToken;
  }
}

interface MfTransactionList {
  data?: Array<{
    id: string;
    account_item_name?: string;
    description?: string;
    amount?: number;
    tax_class?: string;
    occurred_on?: string;
    has_receipt?: boolean;
  }>;
}

async function mfGet<T>(token: string, path: string): Promise<T | null> {
  if (!env.MF_BASE_URL) return null;
  try {
    const res = await request(`${env.MF_BASE_URL}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.statusCode !== 200) {
      logger.warn({ status: res.statusCode, path }, 'mf API non-200');
      return null;
    }
    return (await res.body.json()) as T;
  } catch (err) {
    logger.error({ err, path }, 'mf API exception');
    return null;
  }
}

export const mfApiAdapter: VendorAdapter = {
  source: 'mf',
  async fetchEntries(externalId): Promise<FetchResult<RawEntry>> {
    const client = await loadClientToken(externalId);
    if (!client) return empty();
    const token = await ensureToken(client);
    if (!token) return empty(); // not connected yet — defer to spec 01 OAuth flow

    const json = await mfGet<MfTransactionList>(token, '/api/v1/transactions');
    if (!json?.data) return empty();
    return {
      items: json.data.map((row) => ({
        sourceEntryId: row.id,
        account: row.account_item_name ?? '不明',
        description: row.description ?? '',
        amount: row.amount ?? 0,
        taxClass: row.tax_class,
        occurredAt: row.occurred_on ? new Date(row.occurred_on) : new Date(),
        receiptStatus: row.has_receipt ? 'matched' : 'missing',
        raw: row,
      })),
      fetchedAt: new Date(),
    };
  },
  async fetchReceipts(externalId): Promise<FetchResult<RawReceipt>> {
    const client = await loadClientToken(externalId);
    if (!client) return empty();
    const token = await ensureToken(client);
    if (!token) return empty();
    const json = await mfGet<{ data?: Array<{ id: string; status: string; vendor_name?: string; amount?: number; occurred_on?: string }> }>(
      token,
      '/api/v1/receipts',
    );
    if (!json?.data) return empty();
    return {
      items: json.data.map((row) => ({
        sourceReceiptId: row.id,
        status: row.status === 'attached' ? 'attached' : row.status === 'candidate' ? 'candidate' : 'missing',
        vendorRef: row.vendor_name,
        amount: row.amount,
        occurredAt: row.occurred_on ? new Date(row.occurred_on) : new Date(),
        raw: row,
      })),
      fetchedAt: new Date(),
    };
  },
  async fetchMatchings(externalId): Promise<FetchResult<RawMatching>> {
    const client = await loadClientToken(externalId);
    if (!client) return empty();
    const token = await ensureToken(client);
    if (!token) return empty();
    const json = await mfGet<{ data?: Array<{ id: string; invoice_amount?: number; paid_amount?: number; diff_note?: string; status?: string; occurred_on?: string }> }>(
      token,
      '/api/v1/matchings',
    );
    if (!json?.data) return empty();
    return {
      items: json.data.map((row) => ({
        invoiceRef: row.id,
        invoiceAmount: row.invoice_amount ?? 0,
        paidAmount: row.paid_amount ?? 0,
        diffNote: row.diff_note,
        status: row.status === 'matched' ? 'matched' : row.status === 'urgent' ? 'urgent' : row.status === 'done' ? 'done' : 'open',
        occurredAt: row.occurred_on ? new Date(row.occurred_on) : new Date(),
        raw: row,
      })),
      fetchedAt: new Date(),
    };
  },
};
