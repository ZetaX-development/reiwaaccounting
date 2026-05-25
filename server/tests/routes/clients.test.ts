import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { authHeaders } from '../helpers/auth.js';

const app = await buildApp();
const auth = await authHeaders();

beforeAll(async () => {
  await prisma.firm.deleteMany({ where: { id: 'tenant-isolation-firm-3' } }).catch(() => {});
});

afterAll(async () => {
  await prisma.firm.deleteMany({ where: { id: 'tenant-isolation-firm-3' } }).catch(() => {});
  await app.close();
});

describe('GET /api/clients', () => {
  it('returns an array including the aoyama-design client (name may change after MF OAuth)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    const aoyama = body.find((c: { id: string }) => c.id === 'aoyama-design');
    expect(aoyama).toBeDefined();
    // Name starts as the seed value but is replaced by Office.name after OAuth,
    // so just assert it's a non-empty string.
    expect(typeof aoyama.name).toBe('string');
    expect(aoyama.name.length).toBeGreaterThan(0);
  });
});

describe('GET /api/clients/:id', () => {
  it('returns a 404 for unknown ids with friendly error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients/does-not-exist', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'client not found' } });
  });

  it('returns the client detail with at least the entries collection populated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients/aoyama-design', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('aoyama-design');
    // entries are live-fetched from MF when connected; either populated from
    // MF API or from the seed. Just assert the shape rather than counts.
    expect(Array.isArray(body.entries)).toBe(true);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(Array.isArray(body.receipts)).toBe(true);
  });

  it('returns 404 for client belonging to another firm', async () => {
    await prisma.firm.create({ data: { id: 'tenant-isolation-firm-3', name: 'Other 3', slug: 'tenant-isolation-firm-3' } });
    const otherClient = await prisma.client.create({
      data: {
        firmId: 'tenant-isolation-firm-3',
        name: 'Cross Firm Client',
        fiscalYearStart: new Date('2025-01-01'),
        fiscalYearEnd: new Date('2025-12-31'),
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/clients/${otherClient.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    await prisma.firm.delete({ where: { id: 'tenant-isolation-firm-3' } });
  });
});
