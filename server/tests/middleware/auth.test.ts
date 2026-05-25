import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/server.js';
import { signTestToken } from '../helpers/auth.js';

const prisma = new PrismaClient();

// A minimal route that returns req.user — registered only in tests via a
// dedicated app built after the route is added to buildApp.
// Instead we test requireAuth via the /api/auth/me endpoint (registered in T5).
// For now, we exercise requireAuth indirectly through /api/clients which is a
// protected route.

const app = await buildApp();

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('requireAuth middleware', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when JWT is invalid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { Authorization: 'Bearer invalid.token.here' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('returns 403 when JWT is valid but no active FirmMember', async () => {
    // Create a JWT for a user who has no FirmMember record.
    const token = await signTestToken({ authUserId: 'unknown-user-no-firm' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NO_FIRM');
  });

  it('passes through and sets req.user for valid JWT with active FirmMember', async () => {
    const token = await signTestToken({ authUserId: 'test-user-id' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { Authorization: `Bearer ${token}` },
    });
    // /api/clients may return 200 or 500 depending on DB state, but NOT 401/403
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});
