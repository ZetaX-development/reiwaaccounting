import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  getDemoFirmId,
  listFirms,
  createFirm,
  listMembers,
  inviteMember,
  removeMember,
} from '../../src/services/firm-service.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getDemoFirmId', () => {
  it('returns demo-firm', async () => {
    const id = await getDemoFirmId();
    expect(id).toBe('demo-firm');
  });
});

describe('listFirms', () => {
  it('includes demo-firm in the result', async () => {
    const firms = await listFirms();
    expect(firms.length).toBeGreaterThanOrEqual(1);
    const demo = firms.find((f) => f.id === 'demo-firm');
    expect(demo).not.toBeUndefined();
    expect(demo?.slug).toBe('demo');
    expect(demo?.isDemo).toBe(true);
  });
});

describe('createFirm', () => {
  it('creates Firm + FirmMember(owner/invited)', async () => {
    const slug = `test-firm-${Date.now()}`;
    const firm = await createFirm({
      name: 'Test Accounting',
      slug,
      ownerEmail: 'owner@test.co.jp',
    });

    expect(firm.slug).toBe(slug);

    const member = await prisma.firmMember.findFirst({
      where: { firmId: firm.id, role: 'owner' },
    });
    expect(member).not.toBeNull();
    expect(member?.status).toBe('invited');
    expect(member?.email).toBe('owner@test.co.jp');

    // Cleanup
    await prisma.firmMember.deleteMany({ where: { firmId: firm.id } });
    await prisma.firm.delete({ where: { id: firm.id } });
  });
});

describe('listMembers', () => {
  it('returns only non-removed members of the given firm', async () => {
    const members = await listMembers('demo-firm');
    // setup.ts seeds test-user-id as active owner of demo-firm
    expect(members.length).toBeGreaterThanOrEqual(1);
    expect(members.every((m) => m.firmId === 'demo-firm')).toBe(true);
    expect(members.every((m) => m.status !== 'removed')).toBe(true);
  });
});

describe('inviteMember', () => {
  it('creates FirmMember(member/invited)', async () => {
    const email = `staff-${Date.now()}@test.co.jp`;
    const member = await inviteMember('demo-firm', email, 'test-user-id');

    expect(member.email).toBe(email);
    expect(member.role).toBe('member');
    expect(member.status).toBe('invited');

    // Cleanup
    await prisma.firmMember.delete({ where: { id: member.id } });
  });
});

describe('removeMember', () => {
  it('sets status to removed', async () => {
    const created = await prisma.firmMember.create({
      data: {
        firmId: 'demo-firm',
        authUserId: `remove-test-${Date.now()}`,
        role: 'member',
        status: 'active',
        email: `remove-${Date.now()}@test.co.jp`,
      },
    });

    await removeMember(created.id);

    const updated = await prisma.firmMember.findUnique({
      where: { id: created.id },
    });
    expect(updated?.status).toBe('removed');

    // Cleanup
    await prisma.firmMember.delete({ where: { id: created.id } });
  });
});
