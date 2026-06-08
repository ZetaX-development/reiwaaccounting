import { type FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

export async function knowledgeRoutes(app: FastifyInstance) {
  // 一覧取得
  app.get('/api/knowledge', { preHandler: [requireAuth] }, async (_req, reply) => {
    const chunks = await prisma.knowledgeChunk.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, source: true, page: true, title: true, content: true, accounts: true, taxClass: true, tags: true, createdAt: true },
    });
    reply.send(chunks);
  });

  // 新規作成
  app.post('/api/knowledge', { preHandler: [requireAuth] }, async (req, reply) => {
    const b = req.body as { source: string; page?: string; title: string; content: string; accounts?: string[]; taxClass?: string; tags?: string[] };
    const chunk = await prisma.knowledgeChunk.create({
      data: {
        source: b.source,
        page: b.page || '',
        title: b.title,
        content: b.content,
        accounts: b.accounts || [],
        taxClass: b.taxClass || null,
        tags: b.tags || [],
      },
    });
    reply.status(201).send({ chunk });
  });

  // 削除
  app.delete('/api/knowledge/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.knowledgeChunk.delete({ where: { id } });
    reply.send({ ok: true });
  });
}
