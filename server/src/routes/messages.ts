import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createMessage,
  listThreads,
  sendMessage,
  updateContact,
} from '../services/message-service.js';
import { NotificationError } from '../adapters/notification.js';

const createSchema = z.object({
  clientId: z.string().min(1),
  channel: z.enum(['email', 'slack', 'chatwork', 'line_works', 'messenger']),
  subject: z.string().optional(),
  body: z.string().min(1),
  scheduledAt: z.string().datetime().nullable().optional(),
  originRef: z.string().nullable().optional(),
});

const contactSchema = z.object({
  primary: z.string().optional(),
  endpoints: z.record(z.string().nullable()).optional(),
});

export async function messageRoutes(app: FastifyInstance) {
  app.post('/api/messages', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: { code: 'INVALID_BODY', message: parsed.error.issues.map((i) => i.message).join('; ') },
      };
    }
    try {
      const thread = await createMessage(parsed.data);
      return thread;
    } catch (err) {
      if (err instanceof NotificationError && err.code === 'NOT_FOUND') {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: err.message } };
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/messages/:id/send', async (req, reply) => {
    try {
      const thread = await sendMessage(req.params.id);
      return thread;
    } catch (err) {
      if (err instanceof NotificationError && err.code === 'NOT_FOUND') {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: err.message } };
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/clients/:id/threads', async (req) => {
    return listThreads(req.params.id);
  });

  app.patch<{ Params: { id: string } }>('/api/clients/:id/contact', async (req, reply) => {
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: parsed.error.issues.map((i) => i.message).join('; ') } };
    }
    try {
      return await updateContact(req.params.id, parsed.data);
    } catch {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'client not found' } };
    }
  });
}
