import { describe, it, expect } from 'vitest';
import { mfApiAdapter, buildMfAuthorizeUrl } from '../../src/adapters/mf-api.js';

describe('mfApiAdapter', () => {
  it('reports source as mf', () => {
    expect(mfApiAdapter.source).toBe('mf');
  });

  it('returns empty arrays in the stub implementation', async () => {
    const r = await mfApiAdapter.fetchEntries('any');
    expect(r.items).toEqual([]);
  });
});

describe('buildMfAuthorizeUrl', () => {
  it('embeds clientId, redirectUri, and state', () => {
    const url = buildMfAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'http://localhost:3000/cb',
      state: 'st-1',
      scope: 'mfc/invoice/data.read',
    });
    expect(url).toContain('client_id=cid');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb');
    expect(url).toContain('state=st-1');
    expect(url).toContain('scope=mfc%2Finvoice%2Fdata.read');
    expect(url).toContain('response_type=code');
  });
});
