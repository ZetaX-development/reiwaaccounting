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

// ---------------------------------------------------------------------------
// OAuth helpers
// Auth server: https://api.biz.moneyforward.com/{authorize,token}
// Data API:    https://api-accounting.moneyforward.com/api/v3/...
// Spec source: https://developers.api-accounting.moneyforward.com/v3/openapi.yaml
// ---------------------------------------------------------------------------

// Spec 20: journal.write を追加（LINE→MF自動入力機能）
export const MF_SCOPES = [
  'mfc/accounting/journal.read',
  'mfc/accounting/journal.write',
  'mfc/accounting/accounts.read',
  'mfc/accounting/sub_accounts.read',
  'mfc/accounting/departments.read',
  'mfc/accounting/taxes.read',
  'mfc/accounting/trade_partners.read',
  'mfc/accounting/offices.read',
  'mfc/accounting/report.read',
  'mfc/accounting/connected_account.read',
] as const;

interface AuthorizeOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
}

export function buildMfAuthorizeUrl(opts: AuthorizeOptions): string {
  // GET https://api.biz.moneyforward.com/authorize?response_type=code&...
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: opts.scope,
    response_type: 'code',
    prompt: 'login',
  });
  return `${env.MF_AUTH_BASE_URL}/authorize?${params.toString()}`;
}

export interface MfTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number; // seconds; auth server returns 3600 (1h)
  scope?: string;
  token_type?: string;
}

export async function exchangeAuthorizationCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<MfTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: env.MF_CLIENT_ID,
    client_secret: env.MF_CLIENT_SECRET,
  });
  const res = await request(`${env.MF_AUTH_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`MF token exchange failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
  return (await res.body.json()) as MfTokenResponse;
}

async function refreshAccessToken(refreshToken: string): Promise<MfTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.MF_CLIENT_ID,
    client_secret: env.MF_CLIENT_SECRET,
  });
  const res = await request(`${env.MF_AUTH_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`MF refresh failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
  return (await res.body.json()) as MfTokenResponse;
}

// ---------------------------------------------------------------------------
// Token storage (Client.mfAccessToken / mfRefreshToken / mfTokenExpiresAt)
// ---------------------------------------------------------------------------

interface ClientTokenRecord {
  id: string;
  mfAccessToken: string | null;
  mfRefreshToken: string | null;
  mfTokenExpiresAt: Date | null;
}

// sync-service.ts passes either:
//   - "mock-<clientId>"          (before OAuth — Client.mfExternalId is null)
//   - <office code from MF>      (after OAuth — saved in Client.mfExternalId)
// We resolve back to the Client row in either case so we can read its tokens.
async function loadClientToken(externalId: string): Promise<ClientTokenRecord | null> {
  const select = {
    id: true,
    mfAccessToken: true,
    mfRefreshToken: true,
    mfTokenExpiresAt: true,
  } as const;
  if (externalId.startsWith('mock-')) {
    const id = externalId.slice('mock-'.length);
    return prisma.client.findUnique({ where: { id }, select });
  }
  // Post-OAuth: externalId is the MF office code stored on Client.mfExternalId.
  return prisma.client.findFirst({ where: { mfExternalId: externalId }, select });
}

async function ensureToken(client: ClientTokenRecord): Promise<string | null> {
  if (!client.mfAccessToken) return null;
  const expiringSoon =
    !client.mfTokenExpiresAt ||
    client.mfTokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!expiringSoon) return client.mfAccessToken;
  if (!client.mfRefreshToken || !env.MF_CLIENT_ID || !env.MF_CLIENT_SECRET) {
    return client.mfAccessToken; // best-effort with stale token
  }
  try {
    const refreshed = await refreshAccessToken(client.mfRefreshToken);
    await prisma.client.update({
      where: { id: client.id },
      data: {
        mfAccessToken: refreshed.access_token,
        mfRefreshToken: refreshed.refresh_token ?? client.mfRefreshToken,
        mfTokenExpiresAt: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : null,
      },
    });
    return refreshed.access_token;
  } catch (err) {
    logger.warn({ err, clientId: client.id }, 'mf token refresh failed');
    return client.mfAccessToken;
  }
}

// ---------------------------------------------------------------------------
// Generic GET against the accounting API
// ---------------------------------------------------------------------------

async function mfGet<T>(token: string, path: string): Promise<T | null> {
  try {
    const res = await request(`${env.MF_ACCOUNTING_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (res.statusCode === 401) {
      logger.warn({ path }, 'mf returned 401; token likely expired');
      return null;
    }
    if (res.statusCode === 429) {
      const retryAfter = res.headers['retry-after'];
      logger.warn({ path, retryAfter }, 'mf rate limit hit');
      return null;
    }
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      logger.warn({ status: res.statusCode, path, text: text.slice(0, 200) }, 'mf API non-200');
      return null;
    }
    return (await res.body.json()) as T;
  } catch (err) {
    logger.error({ err, path }, 'mf API exception');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generic POST against the accounting API (Spec 20)
// ---------------------------------------------------------------------------

async function mfPost<T>(token: string, path: string, body: unknown): Promise<{ data: T | null; status: number; error?: string }> {
  try {
    const res = await request(`${env.MF_ACCOUNTING_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.body.text();
    if (res.statusCode === 401) {
      logger.warn({ path }, 'mf POST returned 401');
      return { data: null, status: 401, error: `認証エラー（401）: ${text.slice(0, 200)}` };
    }
    if (res.statusCode >= 400) {
      logger.warn({ status: res.statusCode, path, text: text.slice(0, 300) }, 'mf POST non-2xx');
      if (res.statusCode === 403) {
        return {
          data: null,
          status: 403,
          error: `権限エラー（403）: journal.write スコープ不足の可能性があります。${text.slice(0, 200)}`,
        };
      }
      return { data: null, status: res.statusCode, error: `HTTP ${res.statusCode}: ${text.slice(0, 200)}` };
    }
    return { data: JSON.parse(text) as T, status: res.statusCode };
  } catch (err) {
    logger.error({ err, path }, 'mf POST exception');
    return { data: null, status: 0, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// API response shapes (subset — only fields bookmee actually consumes)
// Source of truth: https://developers.api-accounting.moneyforward.com/v3/openapi.yaml
// ---------------------------------------------------------------------------

interface MfBranchSide {
  value: number;
  tax_value?: number;
  account_id?: string;
  account_name?: string;
  tax_name?: string;
  trade_partner_name?: string;
}

interface MfJournalBranch {
  remark?: string;
  debitor?: MfBranchSide;
  creditor?: MfBranchSide;
}

interface MfJournal {
  id: string;
  number?: number;
  transaction_date: string; // 'YYYY-MM-DD'
  is_realized?: boolean;
  journal_type?: string;
  memo?: string;
  voucher_file_ids?: string[];
  branches?: MfJournalBranch[];
}

interface MfJournalsResponse {
  metadata?: { total_count?: number; total_pages?: number };
  journals?: MfJournal[];
}

interface MfOfficeAccountingPeriod {
  start_date: string;
  end_date: string;
  fiscal_year: number;
}

interface MfOfficeResponse {
  name?: string;
  code?: string;
  type?: 'INDIVIDUAL' | 'CORPORATE';
  accounting_periods?: MfOfficeAccountingPeriod[];
}

// ---------------------------------------------------------------------------
// VendorAdapter implementation
// ---------------------------------------------------------------------------

const empty = <T>(): FetchResult<T> => ({ items: [], fetchedAt: new Date() });

export const mfApiAdapter: VendorAdapter = {
  source: 'mf',

  /**
   * Map MF journals → bookmee RawEntry rows.
   * Each journal has `branches[]`, each branch is a debit/credit pair.
   * For bookmee we surface the debit side as the "expense entry" the
   * accountant reviews. (Money side / 現金 / 預金 is on the credit side.)
   */
  async fetchEntries(externalId, since): Promise<FetchResult<RawEntry>> {
    const client = await loadClientToken(externalId);
    if (!client) return empty();
    const token = await ensureToken(client);
    if (!token) return empty();

    // start_date or end_date is required by the API.
    const startDate = (since ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
      .toISOString()
      .slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    // is_realized を指定しなければ実現 + 未実現の両方が返る (MF 仕様)
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      per_page: '200',
    });
    const json = await mfGet<MfJournalsResponse>(
      token,
      `/api/v3/journals?${params.toString()}`,
    );
    if (!json?.journals) return empty();

    const items: RawEntry[] = [];
    for (const j of json.journals) {
      const occurredAt = new Date(j.transaction_date);
      const branches = j.branches ?? [];
      const hasReceipt = (j.voucher_file_ids?.length ?? 0) > 0;
      const isRealized = j.is_realized !== false; // default true if unspecified
      for (let i = 0; i < branches.length; i++) {
        const debit = branches[i].debitor;
        if (!debit) continue;
        items.push({
          sourceEntryId: branches.length === 1 ? j.id : `${j.id}#${i}`,
          account: debit.account_name ?? '不明',
          description:
            j.memo?.trim() ||
            debit.trade_partner_name ||
            branches[i].creditor?.trade_partner_name ||
            '',
          amount: debit.value,
          taxClass: debit.tax_name,
          occurredAt,
          receiptStatus: hasReceipt ? 'matched' : 'missing',
          isRealized,
          raw: j,
        });
      }
    }
    return { items, fetchedAt: new Date() };
  },

  /**
   * MF Cloud Accounting does not expose a list-all-vouchers endpoint
   * (POST/DELETE only on /vouchers). Receipt presence per journal is
   * already reflected in `Entry.receiptStatus` derived above. Returning
   * empty here keeps the SWR contract honest.
   */
  async fetchReceipts(): Promise<FetchResult<RawReceipt>> {
    return empty<RawReceipt>();
  },

  /**
   * No "matchings" endpoint in the MF accounting API surface — the
   * concept lives upstream in MF クラウド請求書 (a separate product).
   * Spec 01 will add a request adapter when that product is in scope.
   */
  async fetchMatchings(): Promise<FetchResult<RawMatching>> {
    return empty<RawMatching>();
  },
};

/**
 * Returns the connected MF Office for diagnostics (used by the OAuth
 * callback to confirm the connection is alive). Does not affect data sync.
 */
export async function fetchOffice(token: string): Promise<MfOfficeResponse | null> {
  return mfGet<MfOfficeResponse>(token, '/api/v3/offices');
}

// ---------------------------------------------------------------------------
// Spec 20: Journal write helpers
// ---------------------------------------------------------------------------

interface MfAccount {
  id: string;
  name: string;
  account_type?: string;
}

interface MfAccountsResponse {
  accounts?: MfAccount[];
}

/** 勘定科目名 → IDのマップを返す */
export async function fetchAccountMap(token: string): Promise<Map<string, string>> {
  const res = await mfGet<MfAccountsResponse>(token, '/api/v3/accounts');
  const map = new Map<string, string>();
  for (const a of res?.accounts ?? []) {
    map.set(a.name, a.id);
  }
  return map;
}

export interface ResolveClientTokenResult {
  ok: boolean;
  token?: string;
  error?: string;
}

export async function resolveClientToken(clientExternalId: string): Promise<ResolveClientTokenResult> {
  const clientRecord = await loadClientToken(clientExternalId);
  if (!clientRecord) return { ok: false, error: 'クライアントが見つかりません' };
  const token = await ensureToken(clientRecord);
  if (!token) {
    return { ok: false, error: 'MFアクセストークンがありません。OAuth連携を確認してください。' };
  }
  return { ok: true, token };
}

export interface CreateJournalInput {
  transactionDate: string; // 'YYYY-MM-DD'
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  description: string;
  debitTaxName?: string | null;
}

export interface CreateJournalResult {
  ok: boolean;
  journalId?: string;
  error?: string;
}

/** MF Cloud Accounting に仕訳を1件作成する */
export async function createJournalEntry(
  clientExternalId: string,
  input: CreateJournalInput,
  options?: { token?: string },
): Promise<CreateJournalResult> {
  let resolvedToken = options?.token;
  if (!resolvedToken) {
    const resolved = await resolveClientToken(clientExternalId);
    if (!resolved.ok || !resolved.token) {
      return { ok: false, error: resolved.error ?? 'MFアクセストークンがありません。OAuth連携を確認してください。' };
    }
    resolvedToken = resolved.token;
  }

  const body = {
    journal: {
      transaction_date: input.transactionDate,
      journal_type: 'journal_entry',
      memo: input.description,
      branches: [
        {
          remark: input.description,
          debitor: {
            account_id: input.debitAccountId,
            value: input.amount,
          },
          creditor: {
            account_id: input.creditAccountId,
            value: input.amount,
          },
        },
      ],
    },
  };

  const result = await mfPost<{ journal?: { id?: string } }>(resolvedToken, '/api/v3/journals', body);
  if (!result.data) {
    return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  }
  return { ok: true, journalId: result.data.journal?.id };
}

/** MF Cloud Accounting の仕訳摘要を更新する (PUT /api/v3/journals/{id}) */
export async function updateJournalMemo(
  clientExternalId: string,
  journalId: string,
  memo: string,
): Promise<{ ok: boolean; error?: string }> {
  const clientRecord = await loadClientToken(clientExternalId);
  if (!clientRecord) return { ok: false, error: 'クライアントが見つかりません' };
  const token = await ensureToken(clientRecord);
  if (!token) return { ok: false, error: 'MFアクセストークンがありません' };

  try {
    const res = await request(`${env.MF_ACCOUNTING_BASE_URL}/api/v3/journals/${encodeURIComponent(journalId)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ journal: { memo } }),
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      logger.warn({ journalId, status: res.statusCode, text: text.slice(0, 200) }, 'mf PUT journal failed');
      return { ok: false, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
