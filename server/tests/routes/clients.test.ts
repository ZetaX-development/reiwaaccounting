import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('GET /api/clients', () => {
  it('returns an array including the seeded aoyama client', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    const aoyama = body.find((c: { id: string }) => c.id === 'aoyama-design');
    expect(aoyama).toBeDefined();
    expect(aoyama.name).toBe('青山デザイン株式会社');
  });
});

describe('GET /api/clients/:id', () => {
  it('returns a 404 for unknown ids with friendly error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'client not found' } });
  });

  it('returns the seeded client with nested entries, receipts, tasks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients/aoyama-design' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('aoyama-design');
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.receipts.length).toBeGreaterThan(0);
    expect(body.tasks.length).toBeGreaterThan(0);
    // At least one task should be in the awaiting_approval stage (seed has both
    // approved and awaiting_approval tasks, sorted by score desc).
    expect(body.tasks.some((t: { stage: string }) => t.stage === 'awaiting_approval')).toBe(true);
  });
});
