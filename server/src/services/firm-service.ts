import { createClient } from '@supabase/supabase-js';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import type { Firm, FirmMember } from '@prisma/client';

function getAdminClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Exported as a mutable `let` so tests can replace it with a stub.
export let _inviteSupabaseUser: (email: string) => Promise<void> = async (
  email: string,
) => {
  const admin = getAdminClient();
  await admin.auth.admin.inviteUserByEmail(email);
};

export async function getDemoFirmId(): Promise<string> {
  return 'demo-firm';
}

export async function listFirms(): Promise<Firm[]> {
  return prisma.firm.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function getFirm(id: string): Promise<Firm | null> {
  return prisma.firm.findUnique({ where: { id } });
}

export async function createFirm(input: {
  name: string;
  slug: string;
  ownerEmail: string;
}): Promise<Firm> {
  await _inviteSupabaseUser(input.ownerEmail);

  const firm = await prisma.firm.create({
    data: { name: input.name, slug: input.slug },
  });
  await prisma.firmMember.create({
    data: {
      firmId: firm.id,
      authUserId: `pending-${firm.id}`,
      role: 'owner',
      status: 'invited',
      email: input.ownerEmail,
      invitedAt: new Date(),
    },
  });
  return firm;
}

export async function listMembers(firmId: string): Promise<FirmMember[]> {
  return prisma.firmMember.findMany({
    where: { firmId, status: { not: 'removed' } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function inviteMember(
  firmId: string,
  email: string,
  _invitedBy: string,
): Promise<FirmMember> {
  await _inviteSupabaseUser(email);

  return prisma.firmMember.create({
    data: {
      firmId,
      authUserId: `pending-invite-${Date.now()}`,
      role: 'member',
      status: 'invited',
      email,
      invitedAt: new Date(),
    },
  });
}

export async function updateMember(
  memberId: string,
  patch: { role?: string; status?: string },
): Promise<FirmMember> {
  return prisma.firmMember.update({
    where: { id: memberId },
    data: patch,
  });
}

export async function removeMember(memberId: string): Promise<void> {
  await prisma.firmMember.update({
    where: { id: memberId },
    data: { status: 'removed' },
  });
}
