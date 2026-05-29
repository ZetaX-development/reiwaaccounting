import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { computeMissingReceipts } from '../services/receipt-service.js';

const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().optional(),
});

const updateTodoSchema = z
  .object({
    done: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    note: z.string().optional(),
  })
  .refine((v) => v.done !== undefined || v.title !== undefined || v.note !== undefined, {
    message: 'at least one field is required',
  });

export async function todoRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/clients/:id/todos', async (req, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, firmId: req.user!.firmId },
      select: { id: true },
    });
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }

    const [todos, aiPendingCount, aiDifficultCount, missingReceipts] = await Promise.all([
      prisma.todo.findMany({
        where: { clientId: client.id, firmId: req.user!.firmId, done: false },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          note: true,
          done: true,
          createdAt: true,
        },
      }),
      prisma.journalAiReview.count({
        where: { clientId: client.id, firmId: req.user!.firmId, status: 'pending' },
      }),
      prisma.journalAiReview.count({
        where: { clientId: client.id, firmId: req.user!.firmId, status: 'difficult' },
      }),
      computeMissingReceipts(client.id),
    ]);

    return {
      todos,
      aiPendingCount,
      aiDifficultCount,
      missingReceiptCount: missingReceipts.length,
      missingReceipts: missingReceipts.slice(0, 10).map((receipt) => ({
        entryId: receipt.entryId,
        account: receipt.account,
        description: receipt.description,
        amount: receipt.amount,
        occurredAt: receipt.occurredAt.toISOString(),
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/clients/:id/todos', async (req, reply) => {
    const parsed = createTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'invalid body' } };
    }

    const client = await prisma.client.findFirst({
      where: { id: req.params.id, firmId: req.user!.firmId },
      select: { id: true },
    });
    if (!client) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }

    const todo = await prisma.todo.create({
      data: {
        firmId: req.user!.firmId,
        clientId: client.id,
        title: parsed.data.title,
        note: parsed.data.note ?? '',
      },
      select: {
        id: true,
        title: true,
        note: true,
        done: true,
        createdAt: true,
      },
    });

    reply.code(201);
    return todo;
  });

  app.patch<{ Params: { id: string } }>('/api/todos/:id', async (req, reply) => {
    const parsed = updateTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'invalid body' } };
    }

    const current = await prisma.todo.findFirst({
      where: { id: req.params.id, firmId: req.user!.firmId },
      select: { id: true },
    });
    if (!current) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'todo not found' } };
    }

    const data: { done?: boolean; title?: string; note?: string } = {};
    if (parsed.data.done !== undefined) data.done = parsed.data.done;
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.note !== undefined) data.note = parsed.data.note;

    const todo = await prisma.todo.update({
      where: { id: current.id },
      data,
      select: {
        id: true,
        title: true,
        note: true,
        done: true,
        createdAt: true,
      },
    });

    return todo;
  });

  app.delete<{ Params: { id: string } }>('/api/todos/:id', async (req, reply) => {
    const deleted = await prisma.todo.deleteMany({
      where: { id: req.params.id, firmId: req.user!.firmId },
    });

    if (deleted.count === 0) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'todo not found' } };
    }

    return { ok: true };
  });
}
