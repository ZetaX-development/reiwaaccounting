import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('loadEnv', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = original;
  });

  it('throws when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    const { loadEnv } = await import('../src/env.js');
    expect(() => loadEnv()).toThrow(/DATABASE_URL/);
  });

  it('parses required and optional vars with defaults', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@h:5432/d';
    delete process.env.PORT;
    delete process.env.STALE_THRESHOLD_SEC;
    const { loadEnv } = await import('../src/env.js');
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe('postgresql://u:p@h:5432/d');
    expect(env.PORT).toBe(3000);
    expect(env.STALE_THRESHOLD_SEC).toBe(3600);
  });
});
