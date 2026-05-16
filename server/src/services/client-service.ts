import { prisma } from '../lib/prisma.js';
import { mfApiAdapter } from '../adapters/mf-api.js';
import { logger } from '../lib/logger.js';
import type { RawEntry } from '../adapters/vendor-adapter.js';

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

  // Live MF overlay. When the client has an MF token we fetch journals on
  // every request (the user prefers live API over a DB cache).
  let liveItems: RawEntry[] = [];
  if (client.mfAccessToken) {
    try {
      const externalId = client.mfExternalId ?? `mock-${client.id}`;
      const live = await mfApiAdapter.fetchEntries(externalId);
      liveItems = live.items;
    } catch (err) {
      logger.warn({ err, clientId: id }, 'live MF fetch failed');
    }
  }

  if (liveItems.length > 0) {
    const liveEntries = liveItems
      .map((e, i) => ({
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
      }))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    // Replace MF entries (drop stale seeded ones)
    const nonMf = client.entries.filter((row) => row.source !== 'mf');
    client.entries = [...liveEntries, ...nonMf] as typeof client.entries;

    // Synthesise review tasks from MF entries when the DB has none of its
    // own. Each live entry becomes one display task. Status / score derive
    // from whether the journal has a voucher attached and from the amount.
    if (client.tasks.length === 0) {
      const synthTasks = liveItems.map((e, i) => {
        const missing = !e.receiptStatus || e.receiptStatus === 'missing';
        const partial = e.receiptStatus === 'partial';
        const baseScore = Math.min(95, 50 + Math.floor(Math.log10(Math.max(e.amount, 1)) * 8));
        const score = missing ? baseScore + 5 : partial ? baseScore : Math.max(40, baseScore - 10);
        const status = missing ? 'urgent' : partial ? 'open' : 'open';
        const category = missing
          ? '証憑'
          : partial
            ? '証憑'
            : 'AI仕訳候補';
        const dateLabel = e.occurredAt.toISOString().slice(0, 10);
        const amountLabel = '¥' + e.amount.toLocaleString('ja-JP');
        const noteParts = [dateLabel, e.description].filter(Boolean);
        return {
          id: `mf-entry-${e.sourceEntryId || i}`,
          clientId: client.id,
          title: `${e.account} ${amountLabel} の確認`,
          note:
            (missing ? '証憑が未添付です。' : partial ? '証憑が一部のみ添付。' : '内容を確認してください。') +
            (noteParts.length ? ' ' + noteParts.join(' / ') : ''),
          category,
          status,
          score: Math.min(100, score),
          stage: 'awaiting_approval',
          assignee: (client.ownerLabel?.split(' / ')[0] ?? '担当').replace('担当: ', ''),
          approver: '畠山',
          ruleId: null,
          updatedAt: new Date(),
          createdAt: new Date(),
        };
      });
      client.tasks = synthTasks.sort((a, b) => b.score - a.score) as typeof client.tasks;
    }
  }

  return client;
}

/**
 * Returns the live RawEntry[] for a client (used by receipt-service so the
 * missing-receipt detection can run against fresh MF data without touching
 * the Entry table).
 */
export async function getLiveMfEntries(clientId: string): Promise<RawEntry[]> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { mfAccessToken: true, mfExternalId: true },
  });
  if (!client?.mfAccessToken) return [];
  try {
    const externalId = client.mfExternalId ?? `mock-${clientId}`;
    const live = await mfApiAdapter.fetchEntries(externalId);
    return live.items;
  } catch (err) {
    logger.warn({ err, clientId }, 'getLiveMfEntries failed');
    return [];
  }
}
