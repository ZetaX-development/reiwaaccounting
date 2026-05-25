import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/me', async (req, reply) => {
    const user = req.user!;
    const firm = await prisma.firm.findUnique({ where: { id: user.firmId } });
    return reply.send({
      authUserId: user.authUserId,
      firmId: user.firmId,
      role: user.role,
      email: user.email,
      firmName: firm?.name ?? null,
    });
  });
}
