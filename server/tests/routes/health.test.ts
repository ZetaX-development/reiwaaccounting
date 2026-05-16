import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('GET /api/health', () => {
  it('returns ok status with uptime', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});
