import type { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

type RegisterBody = {
  email?: unknown;
  password?: unknown;
  firmName?: unknown;
};

function getSupabaseAdminClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: { params: { eventsPerSecond: 0 } },
    global: { fetch: fetch as never },
  });
}

function sanitizeFirmSlug(email: string): string {
  const localPart = email.split('@')[0] ?? '';
  return localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'firm';
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/register — 新規事務所登録
  // Body: { email, password, firmName }
  app.post('/api/auth/register', async (req, reply) => {
    const body = (req.body as RegisterBody) ?? {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const firmName = typeof body.firmName === 'string' ? body.firmName.trim() : '';

    if (!email || !email.includes('@') || !password || password.length < 8 || !firmName) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_BODY',
          message: 'email, password(8文字以上), firmName are required',
        },
      });
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return reply.code(500).send({
        error: {
          code: 'SUPABASE_NOT_CONFIGURED',
          message: 'Supabase service role configuration is missing',
        },
      });
    }

    const supabaseAdmin = getSupabaseAdminClient();
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      return reply.code(400).send({
        error: {
          code: 'SUPABASE_CREATE_USER_FAILED',
          message: error?.message ?? 'Failed to create Supabase user',
        },
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        const firm = await tx.firm.create({
          data: {
            name: firmName,
            slug: sanitizeFirmSlug(email),
          },
        });
        await tx.firmMember.create({
          data: {
            firmId: firm.id,
            authUserId: data.user.id,
            role: 'owner',
            email,
            status: 'active',
            joinedAt: new Date(),
          },
        });
      });
    } catch (err) {
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(data.user.id);
      if (deleteError) {
        req.log.error({ err: deleteError, authUserId: data.user.id }, 'failed to rollback Supabase user');
      }

      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({
          error: {
            code: 'FIRM_ALREADY_EXISTS',
            message: 'A firm with this slug already exists',
          },
        });
      }
      req.log.error({ err }, 'failed to create registered firm');
      return reply.code(500).send({
        error: {
          code: 'REGISTER_FAILED',
          message: 'Failed to create firm',
        },
      });
    }

    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = req.user!;
    const [firm, member] = await Promise.all([
      prisma.firm.findUnique({ where: { id: user.firmId } }),
      prisma.firmMember.findFirst({ where: { authUserId: user.authUserId, firmId: user.firmId } }),
    ]);
    return reply.send({
      authUserId: user.authUserId,
      firmId: user.firmId,
      role: user.role,
      email: user.email,
      displayName: member?.displayName ?? null,
      firmName: firm?.name ?? null,
    });
  });

  // PATCH /api/auth/me — update own display name
  app.patch('/api/auth/me', async (req, reply) => {
    const user = req.user!;
    const { displayName } = (req.body as { displayName?: string }) ?? {};
    if (typeof displayName !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'displayName string required' } });
    }
    await prisma.firmMember.updateMany({
      where: { authUserId: user.authUserId, firmId: user.firmId },
      data: { displayName: displayName.trim() || null },
    });
    return reply.send({ ok: true });
  });
}
