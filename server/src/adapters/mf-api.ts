import type {
  FetchResult,
  RawEntry,
  RawMatching,
  RawReceipt,
  VendorAdapter,
} from './vendor-adapter.js';
import { env } from '../env.js';

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

// Stub adapter. Real HTTP calls land in spec 01 implementation.
export const mfApiAdapter: VendorAdapter = {
  source: 'mf',
  async fetchEntries(_id): Promise<FetchResult<RawEntry>> {
    return empty<RawEntry>();
  },
  async fetchReceipts(_id): Promise<FetchResult<RawReceipt>> {
    return empty<RawReceipt>();
  },
  async fetchMatchings(_id): Promise<FetchResult<RawMatching>> {
    return empty<RawMatching>();
  },
};
