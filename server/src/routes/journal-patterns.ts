import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { findSimilarPatterns, loadPatternsCache, seedEmbeddings } from '../services/journal-pattern-service.js';

export async function journalPatternRoutes(app: FastifyInstance) {
  app.post('/api/journals/patterns/seed', async () => {
    const result = await seedEmbeddings();
    await loadPatternsCache();
    return { ok: true, ...result };
  });

  app.post('/api/journals/patterns/create', async (req, reply) => {
    const body = req.body as {
      debit: string;
      credit: string;
      scenario: string;
      memoExamples: string[];
      tags?: string[];
      industry?: string;
    };

    const pattern = await prisma.journalPattern.create({
      data: {
        debit: body.debit,
        credit: body.credit,
        scenario: body.scenario,
        memoExamples: body.memoExamples,
        tags: body.tags ?? [],
        industry: body.industry ?? null,
      },
    });

    await loadPatternsCache();
    reply.status(201).send({ pattern });
  });

  app.delete('/api/journals/patterns/:id', async (req) => {
    const { id } = req.params as { id: string };
    await prisma.journalPattern.delete({ where: { id } });
    await loadPatternsCache();
    return { ok: true };
  });

  app.patch('/api/journals/patterns/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      scenario?: string;
      memoExamples?: string[];
      tags?: string[];
      industry?: string;
    };

    const pattern = await prisma.journalPattern.update({
      where: { id },
      data: {
        ...(body.scenario !== undefined ? { scenario: body.scenario } : {}),
        ...(body.memoExamples !== undefined ? { memoExamples: body.memoExamples } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.industry !== undefined ? { industry: body.industry || null } : {}),
      },
    });

    await loadPatternsCache();
    return { pattern };
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

    const take = Number.parseInt(req.query.topK ?? '50', 10);
    const rows = await prisma.journalPattern.findMany({
      orderBy: { createdAt: 'desc' },
      take: Number.isNaN(take) ? 50 : Math.min(Math.max(take, 1), 500),
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
