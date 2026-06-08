import type { FastifyInstance } from 'fastify';
import { emailAdapter } from '../adapters/notification.js';
import { env } from '../env.js';

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/feedback', async (req, reply) => {
    const { title, message } = (req.body as { title?: string; message?: string }) ?? {};
    if (!title || !message) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'title and message are required' } });
    }

    const to = env.FEEDBACK_TO_EMAIL;
    if (!to) {
      // Silently succeed in dev when no recipient is configured
      return reply.send({ ok: true });
    }

    const senderEmail = req.user?.email ?? '(unknown)';
    const subject = `[経理丸投げAI] フィードバック: ${title}`;
    const body = `送信者: ${senderEmail}\n\n${message}`;

    try {
      await emailAdapter.send(to, { subject, body });
    } catch (_err) {
      // Best-effort: don't fail the request if email delivery fails
    }

    return reply.send({ ok: true });
  });
}
