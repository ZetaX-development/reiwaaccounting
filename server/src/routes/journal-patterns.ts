import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { findSimilarPatterns, loadPatternsCache, seedEmbeddings } from '../services/journal-pattern-service.js';

export async function journalPatternRoutes(app: FastifyInstance) {
  app.post('/api/journals/patterns/seed', async () => {
    const result = await seedEmbeddings();
    await loadPatternsCache();
    return { ok: true, ...result };
  });

  app.get<{
    Querystring: {
      debit?: string;
      credit?: string;
      query?: string;
      topK?: string;
    };
  }>('/api/journals/patterns', async (req) => {
    const debit = (req.query.debit ?? '').trim();
    const credit = (req.query.credit ?? '').trim();

    if (debit && credit) {
      const topK = Number.parseInt(req.query.topK ?? '5', 10);
      const queryText = (req.query.query ?? '').trim() || `借方:${debit} 貸方:${credit}`;
      const patterns = await findSimilarPatterns(debit, credit, queryText, Number.isNaN(topK) ? 5 : topK);
      return { patterns };
    }

    const rows = await prisma.journalPattern.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        debit: true,
        credit: true,
        scenario: true,
        memoExamples: true,
        industry: true,
        tags: true,
        amountHint: true,
      },
    });

    return { patterns: rows };
  });
}
