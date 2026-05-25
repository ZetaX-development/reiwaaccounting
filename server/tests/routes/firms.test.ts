import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { authHeaders, signTestToken } from '../helpers/auth.js';

const app = await buildApp();
const auth = await authHeaders(); // test-user-id (owner of demo-firm)

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('POST /api/firms/current/invite', () => {
  beforeEach(async () => {
    await prisma.firmMember.deleteMany({
      where: { firmId: 'demo-firm', authUserId: { startsWith: 'pending-invite-' } },
    });
  });

  it('creates a FirmMember with status=invited when called by owner', async () => {
    const email = `invite-test-${Date.now()}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/firms/current/invite',
      headers: { 'content-type': 'application/json', ...auth },
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe(email);
    expect(body.status).toBe('invited');
    expect(body.role).toBe('member');

    // Cleanup
    await prisma.firmMember.deleteMany({ where: { id: body.id } });
  });
});

describe('PATCH /api/firms/current/members/:mid', () => {
  it('updates role for a member in the same firm', async () => {
    const created = await prisma.firmMember.create({
      data: {
        firmId: 'demo-firm',
        authUserId: `patch-test-${Date.now()}`,
        role: 'member',
        status: 'active',
        email: `patch-${Date.now()}@example.com`,
      },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/firms/current/members/${created.id}`,
      headers: { 'content-type': 'application/json', ...auth },
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('owner');

    // Cleanup
    await prisma.firmMember.delete({ where: { id: created.id } });
  });
});

describe('PATCH /api/firms/current/members/:mid (cross-firm)', () => {
  it('returns 403 when member belongs to a different firm', async () => {
    // Create a second firm and a member in it.
    const otherFirm = await prisma.firm.create({
      data: { name: 'Other Firm', slug: `other-${Date.now()}` },
    });
    const otherMember = await prisma.firmMember.create({
      data: {
        firmId: otherFirm.id,
        authUserId: `other-user-${Date.now()}`,
        role: 'member',
        status: 'active',
        email: `other-${Date.now()}@example.com`,
      },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/firms/current/members/${otherMember.id}`,
      headers: { 'content-type': 'application/json', ...auth },
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(403);

    // Cleanup
    await prisma.firmMember.delete({ where: { id: otherMember.id } });
    await prisma.firm.delete({ where: { id: otherFirm.id } });
  });
});
