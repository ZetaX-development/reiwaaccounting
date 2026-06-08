import type { FastifyInstance } from 'fastify';
import { generateTrainingCards, getTrainingStats } from '../services/training-service.js';

export async function trainingRoutes(app: FastifyInstance) {
  // GET /api/training/stats - summary counts
  app.get('/api/training/stats', async (req) => {
    return getTrainingStats(req.user!.firmId);
  });

  // POST /api/training/cards - generate training cards
  // Body: { useAI?: boolean, limit?: number }
  app.post<{ Body: { useAI?: boolean; limit?: number } }>(
    '/api/training/cards',
    async (req) => {
      const useAI = req.body?.useAI ?? false;
      const limit = Math.min(Number(req.body?.limit) || 20, 50);
      const cards = await generateTrainingCards(req.user!.firmId, { useAI, limit });
      return { cards };
    },
  );
}
