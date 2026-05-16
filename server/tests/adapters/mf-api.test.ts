import { describe, it, expect, afterAll } from 'vitest';
import {
  mfApiAdapter,
  buildMfAuthorizeUrl,
  MF_SCOPES,
} from '../../src/adapters/mf-api.js';
import { prisma } from '../../src/lib/prisma.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('mfApiAdapter', () => {
  it('reports source as mf', () => {
    expect(mfApiAdapter.source).toBe('mf');
  });

  it('returns empty arrays when the seeded client has no MF token', async () => {
    // Seeded clients have no mfAccessToken set, so the adapter should bail
    // out quietly rather than calling the real API.
    const r = await mfApiAdapter.fetchEntries('mock-aoyama-design');
    expect(r.items).toEqual([]);
    const r2 = await mfApiAdapter.fetchReceipts('mock-aoyama-design');
    expect(r2.items).toEqual([]);
    const r3 = await mfApiAdapter.fetchMatchings('mock-aoyama-design');
    expect(r3.items).toEqual([]);
  });

  it('returns empty arrays for unknown ids without throwing', async () => {
    const r = await mfApiAdapter.fetchEntries('mock-does-not-exist');
    expect(r.items).toEqual([]);
  });
});

describe('MF_SCOPES', () => {
  it('only requests read-scopes (zeimee writes nothing back to MF)', () => {
    for (const s of MF_SCOPES) {
      expect(s.endsWith('.read')).toBe(true);
    }
  });
  it('includes journal.read and accounts.read at minimum', () => {
    expect(MF_SCOPES).toContain('mfc/accounting/journal.read');
    expect(MF_SCOPES).toContain('mfc/accounting/accounts.read');
  });
});

describe('buildMfAuthorizeUrl', () => {
  it('targets the MF authorization server and embeds all OAuth params', () => {
    const url = buildMfAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'http://localhost:3000/cb',
      state: 'st-1',
      scope: MF_SCOPES.join(' '),
    });
    expect(url.startsWith('https://api.biz.moneyforward.com/authorize?')).toBe(true);
    expect(url).toContain('client_id=cid');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb');
    expect(url).toContain('state=st-1');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=mfc%2Faccounting%2Fjournal.read');
  });
});
