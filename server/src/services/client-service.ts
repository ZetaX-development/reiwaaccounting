import { prisma } from '../lib/prisma.js';
import { mfApiAdapter } from '../adapters/mf-api.js';
import { logger } from '../lib/logger.js';

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
  const client = await prisma.client.findUnique({
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
  if (!client) return null;

  // If the client is connected to MF, fetch live entries every time and
  // overlay them on top of the DB rows. We don't persist them — the user
  // explicitly prefers fresh API data over a cached copy.
  if (client.mfAccessToken) {
    try {
      const externalId = client.mfExternalId ?? `mock-${client.id}`;
      const live = await mfApiAdapter.fetchEntries(externalId);
      if (live.items.length > 0) {
        const liveEntries = live.items.map((e, i) => ({
          // Synthesise an id stable enough for the React-less render loop.
          id: `live-mf-${e.sourceEntryId || i}`,
          clientId: client.id,
          source: 'mf' as const,
          sourceEntryId: e.sourceEntryId,
          account: e.account,
          description: e.description,
          amount: e.amount,
          taxClass: e.taxClass ?? null,
          occurredAt: e.occurredAt,
          receiptStatus: e.receiptStatus ?? 'na',
          score: null,
          requestedAt: null,
          raw: null,
          syncedAt: new Date(),
        }));
        // Drop the seeded MF entries (they're now stale) and prepend live.
        const nonMf = client.entries.filter((row) => row.source !== 'mf');
        client.entries = [
          ...liveEntries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()),
          ...nonMf,
        ] as typeof client.entries;
      }
    } catch (err) {
      logger.warn({ err, clientId: id }, 'live MF fetch failed; falling back to DB entries');
    }
  }

  return client;
}
