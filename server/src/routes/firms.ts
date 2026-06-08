import type { FastifyInstance } from 'fastify';
import { requireOwner } from '../middleware/auth.js';
import {
  listMembers,
  inviteMember,
  updateMember,
  removeMember,
} from '../services/firm-service.js';
import { prisma } from '../lib/prisma.js';

export async function firmRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/firms/current', async (req, reply) => {
    const { firmId } = req.user!;
    const firm = await prisma.firm.findUnique({ where: { id: firmId } });
    if (!firm) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

    const memberCount = await prisma.firmMember.count({
      where: { firmId, status: { not: 'removed' } },
    });
    return reply.send({ ...firm, memberCount });
  });

  app.get(
    '/api/firms/current/members',
    { preHandler: requireOwner },
    async (req, reply) => {
      const members = await listMembers(req.user!.firmId);
      return reply.send(members);
    },
  );

  app.post(
    '/api/firms/current/invite',
    { preHandler: requireOwner },
    async (req, reply) => {
      const { email } = req.body as { email: string };
      if (!email) {
        return reply.code(400).send({ error: { code: 'EMAIL_REQUIRED' } });
      }
      const member = await inviteMember(
        req.user!.firmId,
        email,
        req.user!.authUserId,
      );
      return reply.code(201).send(member);
    },
  );

  app.patch(
    '/api/firms/current/members/:mid',
    { preHandler: requireOwner },
    async (req, reply) => {
      const { mid } = req.params as { mid: string };
      const patch = req.body as { role?: string; status?: string };

      // Verify the member belongs to the caller's firm.
      const existing = await prisma.firmMember.findUnique({
        where: { id: mid },
      });
      if (!existing || existing.firmId !== req.user!.firmId) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN' } });
      }

      const updated = await updateMember(mid, patch);
      return reply.send(updated);
    },
  );

  app.delete(
    '/api/firms/current/members/:mid',
    { preHandler: requireOwner },
    async (req, reply) => {
      const { mid } = req.params as { mid: string };

      const existing = await prisma.firmMember.findUnique({
        where: { id: mid },
      });
      if (!existing || existing.firmId !== req.user!.firmId) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN' } });
      }

      await removeMember(mid);
      return reply.code(204).send();
    },
  );

  // PATCH /api/firms/current — update firm settings (owner only)
  app.patch(
    '/api/firms/current',
    { preHandler: requireOwner },
    async (req, reply) => {
      const { firmId } = req.user!;
      const body = (req.body as { settings?: Record<string, unknown> }) ?? {};
      if (!body.settings || typeof body.settings !== 'object') {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'settings object required' } });
      }
      const firm = await prisma.firm.findUnique({ where: { id: firmId }, select: { settings: true } });
      const current = (firm?.settings as Record<string, unknown>) ?? {};
      const merged: Record<string, unknown> = { ...current, ...body.settings };
      const updated = await prisma.firm.update({ where: { id: firmId }, data: { settings: merged as never } });
      return reply.send(updated);
    },
  );

  // GET /api/firms/current/activity — recent outreach threads (owner only)
  app.get(
    '/api/firms/current/activity',
    { preHandler: requireOwner },
    async (req, reply) => {
      const threads = await prisma.thread.findMany({
        where: { firmId: req.user!.firmId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          clientId: true,
          channel: true,
          subject: true,
          preview: true,
          status: true,
          sentAt: true,
          createdAt: true,
        },
      });
      return reply.send(threads);
    },
  );
}
