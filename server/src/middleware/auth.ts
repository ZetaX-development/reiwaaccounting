import { jwtVerify } from 'jose';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

function getJwtKey(): Uint8Array {
  return new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
  }

  let payload: { sub?: string };
  try {
    const result = await jwtVerify(auth.slice(7), getJwtKey(), {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: env.SUPABASE_JWT_AUDIENCE,
    });
    payload = result.payload as { sub?: string };
  } catch {
    return reply.code(401).send({ error: { code: 'INVALID_TOKEN' } });
  }

  const member = await prisma.firmMember.findFirst({
    where: { authUserId: payload.sub as string, status: 'active' },
    select: { firmId: true, role: true, email: true },
  });
  if (!member) {
    return reply.code(403).send({ error: { code: 'NO_FIRM' } });
  }

  req.user = {
    authUserId: payload.sub as string,
    firmId: member.firmId,
    role: member.role as 'owner' | 'member',
    email: member.email,
  };

  // Set JWT claims as session variable for RLS policies.
  await prisma.$executeRawUnsafe(
    `SET LOCAL "request.jwt.claims" = '${JSON.stringify({ sub: payload.sub, role: 'authenticated' })}'`,
  );
}

export async function requireOwner(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (req.user?.role !== 'owner') {
    return reply.code(403).send({ error: { code: 'OWNER_REQUIRED' } });
  }
}
