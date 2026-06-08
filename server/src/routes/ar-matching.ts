import type { FastifyInstance } from 'fastify';
import { matchArEntries } from '../services/ar-matching-service.js';

export async function arMatchingRoutes(app: FastifyInstance) {
  /**
   * GET /api/clients/:id/ar-matching
   *
   * 売掛金エントリと入金エントリを突合し、未回収の売掛金を返す。
   * MF OAuth 未連携のクライアントは空の結果を返す（エラーにしない）。
   */
  app.get<{ Params: { id: string } }>('/api/clients/:id/ar-matching', async (req, reply) => {
    try {
      const result = await matchArEntries(req.params.id, req.user!.firmId);
      return result;
    } catch (err: unknown) {
      reply.code(500);
      return {
        error: {
          code: 'AR_MATCHING_FAILED',
          message: err instanceof Error ? err.message : 'ar matching failed',
        },
      };
    }
  });
}

// ---------------------------------------------------------------------------
// server.ts への登録方法
//
// buildApp() 内の他のルート登録と同じ場所に以下を追加してください:
//
//   import { arMatchingRoutes } from './routes/ar-matching.js';
//   ...
//   await app.register(arMatchingRoutes);
//
// ---------------------------------------------------------------------------
