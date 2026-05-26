import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { processBlankMemoJournals } from '../services/journal-ai-review-service.js';
import { updateJournalMemo } from '../adapters/mf-api.js';

export async function journalReviewRoutes(app: FastifyInstance) {
  // GET /api/clients/:id/mf/journal-reviews — レビュー待ち一覧
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/clients/:id/mf/journal-reviews',
    async (req, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!client) { reply.code(404); return { error: { code: 'NOT_FOUND' } }; }

      const status = req.query.status ?? 'pending';
      const reviews = await prisma.journalAiReview.findMany({
        where: { clientId: client.id, firmId: req.user!.firmId, status },
        orderBy: { transactionDate: 'desc' },
      });

      const pendingCount = await prisma.journalAiReview.count({
        where: { clientId: client.id, firmId: req.user!.firmId, status: 'pending' },
      });

      return { reviews, pendingCount };
    },
  );

  // POST /api/clients/:id/mf/journal-reviews/process — AI処理実行
  app.post<{ Params: { id: string } }>(
    '/api/clients/:id/mf/journal-reviews/process',
    async (req, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!client) { reply.code(404); return { error: { code: 'NOT_FOUND' } }; }

      reply.code(202);
      const result = { ok: true, processing: true };
      // バックグラウンドで処理
      setImmediate(() => {
        processBlankMemoJournals(client.id, req.user!.firmId).catch(() => {});
      });
      return result;
    },
  );

  // POST /api/clients/:id/mf/journal-reviews/auto-classify — AI処理をローカル一括承認
  app.post<{ Params: { id: string } }>(
    '/api/clients/:id/mf/journal-reviews/auto-classify',
    async (req, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: req.params.id, firmId: req.user!.firmId },
        select: { id: true },
      });
      if (!client) { reply.code(404); return { error: { code: 'NOT_FOUND' } }; }

      const result = await processBlankMemoJournals(client.id, req.user!.firmId, { localOnly: true });
      const updatedPending = await prisma.journalAiReview.updateMany({
        where: { clientId: client.id, firmId: req.user!.firmId, status: 'pending' },
        data: { status: 'auto_applied' },
      });

      return { ok: true, processed: result.total + updatedPending.count };
    },
  );

  // POST /api/clients/:id/mf/journal-reviews/:reviewId/approve — 承認してMFに反映
  app.post<{ Params: { id: string; reviewId: string }; Body: { memo?: string } }>(
    '/api/clients/:id/mf/journal-reviews/:reviewId/approve',
    async (req, reply) => {
      const review = await prisma.journalAiReview.findFirst({
        where: { id: req.params.reviewId, firmId: req.user!.firmId },
      });
      if (!review) { reply.code(404); return { error: { code: 'NOT_FOUND' } }; }

      const client = await prisma.client.findUnique({
        where: { id: review.clientId },
        select: { mfExternalId: true },
      });

      const memo = req.body?.memo ?? review.aiMemo ?? '';
      const putResult = await updateJournalMemo(
        client?.mfExternalId ?? `mock-${review.clientId}`,
        review.mfJournalId,
        memo,
      );

      await prisma.journalAiReview.update({
        where: { id: review.id },
        data: {
          status: putResult.ok ? 'approved' : 'pending',
          aiMemo: memo,
          errorMsg: putResult.ok ? null : putResult.error,
        },
      });

      if (!putResult.ok) {
        reply.code(500);
        return { error: { code: 'MF_PUT_FAILED', message: putResult.error } };
      }
      return { ok: true };
    },
  );

  // POST /api/clients/:id/mf/journal-reviews/:reviewId/skip — スキップ
  app.post<{ Params: { id: string; reviewId: string } }>(
    '/api/clients/:id/mf/journal-reviews/:reviewId/skip',
    async (req, reply) => {
      const review = await prisma.journalAiReview.findFirst({
        where: { id: req.params.reviewId, firmId: req.user!.firmId },
      });
      if (!review) { reply.code(404); return { error: { code: 'NOT_FOUND' } }; }

      await prisma.journalAiReview.update({
        where: { id: review.id },
        data: { status: 'skipped' },
      });
      return { ok: true };
    },
  );
}
