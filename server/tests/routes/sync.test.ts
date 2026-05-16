import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('POST /api/clients/:id/sync', () => {
  it('returns ok status for the seeded client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients/aoyama-design/sync',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.vendor).toBe('mf');
  });

  it('returns 404 for unknown clients', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients/missing/sync',
    });
    expect(res.statusCode).toBe(404);
  });
});
