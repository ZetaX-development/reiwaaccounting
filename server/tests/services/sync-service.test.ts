import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { syncClient, isStale } from '../../src/services/sync-service.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('isStale', () => {
  it('returns true when lastSync is null', () => {
    expect(isStale(null, 60)).toBe(true);
  });
  it('returns true when lastSync is older than threshold', () => {
    const old = new Date(Date.now() - 120_000);
    expect(isStale(old, 60)).toBe(true);
  });
  it('returns false when lastSync is fresh', () => {
    const recent = new Date(Date.now() - 1000);
    expect(isStale(recent, 60)).toBe(false);
  });
});

describe('syncClient', () => {
  it('updates VendorSync.lastSync for the seeded client', async () => {
    const before = await prisma.vendorSync.findFirst({
      where: { clientId: 'aoyama-design' },
    });
    // Wait a millisecond so the new lastSync is strictly greater
    await new Promise((r) => setTimeout(r, 5));
    const result = await syncClient('aoyama-design');
    expect(result.status).toBe('ok');
    expect(result.vendor).toBe('mf');
    const after = await prisma.vendorSync.findFirst({
      where: { clientId: 'aoyama-design' },
    });
    expect(after?.lastSync?.getTime()).toBeGreaterThan(
      before?.lastSync?.getTime() ?? 0,
    );
  });

  it('returns error envelope for unknown clientId', async () => {
    const result = await syncClient('does-not-exist');
    expect(result.status).toBe('error');
    expect(result.errorMsg).toBe('client not found');
  });
});
