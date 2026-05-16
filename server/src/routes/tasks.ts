import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listHistory,
  listTasks,
  TaskTransitionError,
  transitionTask,
  type Role,
  type Stage,
} from '../services/task-service.js';

const transitionSchema = z.object({
  action: z.enum(['staff_complete', 'approve', 'reject', 'resubmit']),
  by: z.string().min(1),
  comment: z.string().optional(),
});

export async function taskRoutes(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: { role?: Role; stage?: Stage };
  }>('/api/clients/:id/tasks', async (req) => {
    return listTasks(req.params.id, req.query.role, req.query.stage);
  });

  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/transition',
    async (req, reply) => {
      const parsed = transitionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: {
            code: 'INVALID_BODY',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        };
      }
      try {
        const updated = await transitionTask({
          taskId: req.params.id,
          ...parsed.data,
        });
        return updated;
      } catch (err) {
        if (err instanceof TaskTransitionError) {
          reply.code(err.code === 'NOT_FOUND' ? 404 : 409);
          return { error: { code: err.code, message: err.message } };
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/tasks/:id/history', async (req) => {
    return listHistory(req.params.id);
  });
}
