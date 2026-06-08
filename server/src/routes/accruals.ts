import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { detectAccrualCandidates } from '../services/accrual-service.js';

export async function accrualRoutes(app: FastifyInstance) {
  /**
   * GET /api/clients/:id/accruals
   * 期間配分候補（未払費用・前払費用）を返す
   */
  app.get<{ Params: { id: string } }>('/api/clients/:id/accruals', async (req, reply) => {
    const clientId = req.params.id;
    const firmId = req.user!.firmId;

    // firmId で絞り込んでマルチテナント分離を保証
    const client = await prisma.client.findFirst({
      where: { id: clientId, firmId },
      select: { fiscalYearEnd: true },
    });

    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }

    const fiscalYearEndStr = client.fiscalYearEnd.toISOString().slice(0, 10);
    const candidates = await detectAccrualCandidates(clientId, firmId, fiscalYearEndStr);

    return { candidates };
  });
}

// server.ts への登録方法:
// import { accrualRoutes } from './routes/accruals.js';
// app.register(accrualRoutes);
