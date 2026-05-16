import { describe, it, expect } from 'vitest';
import { freeeMockAdapter } from '../../src/adapters/freee-mock.js';

describe('freeeMockAdapter', () => {
  it('reports source as freee', () => {
    expect(freeeMockAdapter.source).toBe('freee');
  });

  it('returns at least one entry per known external id', async () => {
    const result = await freeeMockAdapter.fetchEntries('mock-aoyama-design');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].sourceEntryId).toMatch(/^freee-/);
    expect(result.fetchedAt).toBeInstanceOf(Date);
  });

  it('returns empty arrays for unknown external id', async () => {
    const entries = await freeeMockAdapter.fetchEntries('unknown');
    const receipts = await freeeMockAdapter.fetchReceipts('unknown');
    const matchings = await freeeMockAdapter.fetchMatchings('unknown');
    expect(entries.items).toEqual([]);
    expect(receipts.items).toEqual([]);
    expect(matchings.items).toEqual([]);
  });
});
