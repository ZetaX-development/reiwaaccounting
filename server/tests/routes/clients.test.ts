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

describe('POST /api/clients', () => {
  let createdId: string;

  afterAll(async () => {
    if (createdId) {
      await prisma.client.deleteMany({ where: { id: createdId } }).catch(() => {});
    }
  });

  it('creates a client with required fields and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        name: 'テスト株式会社',
        fiscalYearStart: '2025-01-01',
        fiscalYearEnd: '2025-12-31',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe('テスト株式会社');
    createdId = body.id;
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        fiscalYearStart: '2025-01-01',
        fiscalYearEnd: '2025-12-31',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_BODY');
  });

  it('returns 400 when fiscalYearEnd is before fiscalYearStart', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        name: '不正期間会社',
        fiscalYearStart: '2025-12-31',
        fiscalYearEnd: '2025-01-01',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_BODY');
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

describe('PATCH /api/clients/:id', () => {
  let patchClientId: string;
  let otherFirmClientId: string;

  beforeAll(async () => {
    const c = await prisma.client.create({
      data: {
        firmId: 'demo-firm',
        name: 'PATCH対象会社',
        fiscalYearStart: new Date('2025-01-01'),
        fiscalYearEnd: new Date('2025-12-31'),
      },
    });
    patchClientId = c.id;

    await prisma.firm.create({ data: { id: 'tenant-isolation-firm-4', name: 'Other 4', slug: 'tenant-isolation-firm-4' } });
    const oc = await prisma.client.create({
      data: {
        firmId: 'tenant-isolation-firm-4',
        name: 'Other Firm Client',
        fiscalYearStart: new Date('2025-01-01'),
        fiscalYearEnd: new Date('2025-12-31'),
      },
    });
    otherFirmClientId = oc.id;
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: patchClientId } }).catch(() => {});
    await prisma.firm.deleteMany({ where: { id: 'tenant-isolation-firm-4' } }).catch(() => {});
  });

  it('updates client fields and returns 200', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${patchClientId}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: '更新後会社名', industry: '製造業' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const updated = await prisma.client.findUnique({ where: { id: patchClientId } });
    expect(updated?.name).toBe('更新後会社名');
    expect(updated?.industry).toBe('製造業');
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/does-not-exist',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for client belonging to another firm', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${otherFirmClientId}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/clients/:id', () => {
  it('deletes a client and returns 200', async () => {
    const c = await prisma.client.create({
      data: {
        firmId: 'demo-firm',
        name: '削除対象会社',
        fiscalYearStart: new Date('2025-01-01'),
        fiscalYearEnd: new Date('2025-12-31'),
      },
    });
    const res = await app.inject({ method: 'DELETE', url: `/api/clients/${c.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const gone = await prisma.client.findUnique({ where: { id: c.id } });
    expect(gone).toBeNull();
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/clients/does-not-exist', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for client belonging to another firm', async () => {
    await prisma.firm.create({ data: { id: 'tenant-isolation-firm-5', name: 'Other 5', slug: 'tenant-isolation-firm-5' } });
    const oc = await prisma.client.create({
      data: {
        firmId: 'tenant-isolation-firm-5',
        name: 'Other Client 5',
        fiscalYearStart: new Date('2025-01-01'),
        fiscalYearEnd: new Date('2025-12-31'),
      },
    });
    const res = await app.inject({ method: 'DELETE', url: `/api/clients/${oc.id}`, headers: auth });
    expect(res.statusCode).toBe(404);
    await prisma.firm.delete({ where: { id: 'tenant-isolation-firm-5' } });
  });
});
