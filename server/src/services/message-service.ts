import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  type Channel,
  formatForChannel,
  getAdapter,
  NotificationError,
} from '../adapters/notification.js';

export interface CreateMessageInput {
  clientId: string;
  channel: Channel;
  subject?: string;
  body: string;
  scheduledAt?: string | null;
  originRef?: string | null;
}

export async function createMessage(input: CreateMessageInput) {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client) {
    throw new NotificationError('NOT_FOUND', 'client not found');
  }
  const thread = await prisma.thread.create({
    data: {
      firmId: 'demo-firm',
      clientId: input.clientId,
      channel: input.channel,
      direction: 'out',
      subject: input.subject,
      body: input.body,
      preview: input.body.slice(0, 80),
      status: input.scheduledAt ? 'queued' : 'queued',
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
    },
  });
  // If immediate, attempt send right away.
  if (!input.scheduledAt) {
    return sendMessage(thread.id);
  }
  return thread;
}

export async function sendMessage(threadId: string) {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { client: true },
  });
  if (!thread) {
    throw new NotificationError('NOT_FOUND', 'thread not found');
  }
  const channel = thread.channel as Channel;
  const endpoints = (thread.client.contactEndpoints ?? {}) as Record<string, string | null>;
  const endpoint = endpoints[channel];
  if (!endpoint) {
    const errorMsg = `${channel} の宛先が顧問先設定にありません`;
    return prisma.thread.update({
      where: { id: thread.id },
      data: { status: 'failed', errorMsg },
    });
  }

  try {
    const adapter = getAdapter(channel);
    const result = await adapter.send(endpoint, {
      subject: thread.subject ?? undefined,
      body: thread.body,
    });
    return prisma.thread.update({
      where: { id: thread.id },
      data: {
        status: 'sent',
        sentAt: new Date(),
        externalId: result.externalId,
        errorMsg: null,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ threadId: thread.id, errorMsg }, 'send failed');
    return prisma.thread.update({
      where: { id: thread.id },
      data: { status: 'failed', errorMsg },
    });
  }
}

export async function listThreads(clientId: string) {
  return prisma.thread.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export interface ContactUpdateInput {
  primary?: string;
  endpoints?: Record<string, string | null>;
}

export async function updateContact(clientId: string, input: ContactUpdateInput) {
  const data: { contactPrimary?: string; contactEndpoints?: Record<string, string | null> } = {};
  if (input.primary) data.contactPrimary = input.primary;
  if (input.endpoints) data.contactEndpoints = input.endpoints;
  return prisma.client.update({
    where: { id: clientId },
    data,
    select: { id: true, contactPrimary: true, contactEndpoints: true },
  });
}

// Re-export for the route layer
export { formatForChannel };
