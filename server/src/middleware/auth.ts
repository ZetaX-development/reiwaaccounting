import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

// Supabase newer projects use ES256 with JWKS. Cache the key set at module load.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(
      new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    );
  }
  return _jwks;
}

/**
 * Verify a Supabase JWT. Two modes:
 *  - Production / development: JWKS endpoint (ES256, new Supabase projects).
 *  - Test: HS256 with SUPABASE_JWT_SECRET (avoids hitting Supabase network in CI).
 */
async function verifyToken(token: string): Promise<{ sub?: string }> {
  if (env.NODE_ENV === 'test' && env.SUPABASE_JWT_SECRET) {
    const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    const result = await jwtVerify(token, secret, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: env.SUPABASE_JWT_AUDIENCE,
    });
    return result.payload as { sub?: string };
  }
  const result = await jwtVerify(token, getJwks(), {
    issuer: `${env.SUPABASE_URL}/auth/v1`,
    audience: env.SUPABASE_JWT_AUDIENCE,
  });
  return result.payload as { sub?: string };
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Local dev bypass: skip JWT and use demo-firm
  if (env.DEV_BYPASS_AUTH && env.NODE_ENV !== 'production') {
    req.user = {
      authUserId: 'dev-user',
      firmId: 'demo-firm',
      role: 'owner',
      email: 'dev@localhost',
    };
    return;
  }

  if (!env.SUPABASE_URL) {
    return reply.code(503).send({
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message: 'SUPABASE_URL is not set on the server',
      },
    });
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
  }

  let payload: { sub?: string };
  try {
    payload = await verifyToken(auth.slice(7));
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
  // Use typed $executeRaw (parameterised) to prevent SQL injection.
  await prisma.$executeRaw`SET LOCAL "request.jwt.claims" = ${JSON.stringify({ sub: payload.sub, role: 'authenticated' })}`;
}

export async function requireOwner(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (req.user?.role !== 'owner') {
    return reply.code(403).send({ error: { code: 'OWNER_REQUIRED' } });
  }
}
