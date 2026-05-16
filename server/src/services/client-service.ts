import { prisma } from '../lib/prisma.js';

export async function listClients() {
  return prisma.client.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      industry: true,
      vendor: true,
      mode: true,
      ownerLabel: true,
      progress: true,
      tasksOpen: true,
      risk: true,
      receipt: true,
      missing: true,
      diff: true,
      matches: true,
      chatMessage: true,
      messageDraft: true,
      contactPrimary: true,
      contactEndpoints: true,
    },
  });
}

export async function getClientById(id: string) {
  return prisma.client.findUnique({
    where: { id },
    include: {
      entries: { orderBy: { occurredAt: 'desc' } },
      receipts: { orderBy: { occurredAt: 'desc' } },
      matchings: { orderBy: { occurredAt: 'desc' } },
      monthlyChecks: true,
      trendData: true,
      rules: { include: { hits: true } },
      tasks: { orderBy: { score: 'desc' } },
      vendorSyncs: true,
    },
  });
}
