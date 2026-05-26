import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
  }));

  // TEMPORARY: reassign LINE vouchers to nihonbashi-kogyo — remove after use
  app.post<{ Querystring: { secret?: string } }>('/api/admin/fix-line-vouchers', async (req, reply) => {
    if (req.query.secret !== 'zetax2026fix') { reply.code(403); return { error: 'forbidden' }; }
    const result = await prisma.voucher.updateMany({
      where: { source: 'line', clientId: { not: 'nihonbashi-kogyo' } },
      data: { clientId: 'nihonbashi-kogyo', matchedClientReason: 'manual' },
    });
    return { updated: result.count };
  });
}
