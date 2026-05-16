import { prisma } from '../lib/prisma.js';
import { getSyncStatus } from './sync-status-service.js';

export interface SummaryResponse {
  // per-client (when clientId provided) or aggregated (when not)
  clientId?: string;
  mode: 'monthly' | 'yearend';
  cards: SummaryCard[];
  pendingByChannel: Record<string, number>;
  vendorSyncOkRate: number; // 5th card value (matches sync-status.okRate)
}

export interface SummaryCard {
  key: string;
  label: string;
  value: string;
  sublabel?: string;
  subvalue?: string;
}

export async function getSummary(clientId?: string): Promise<SummaryResponse> {
  const status = await getSyncStatus();

  // per-client
  if (clientId) {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      include: { tasks: true, vendorSyncs: true },
    });
    if (!client) {
      return {
        mode: 'monthly',
        cards: [],
        pendingByChannel: {},
        vendorSyncOkRate: status.okRate,
      };
    }

    const awaiting = client.tasks.filter((t) => t.stage === 'awaiting_approval').length;
    const rejected = client.tasks.filter((t) => t.stage === 'rejected').length;

    const cards: SummaryCard[] = [
      {
        key: 'progress',
        label: 'レビュー完了率',
        value: `${client.progress}%`,
        sublabel: '',
      },
      {
        key: 'awaiting',
        label: '所長確認待ち',
        value: `${awaiting}`,
        sublabel: '高優先度',
        subvalue: `${client.risk}件`,
      },
      {
        key: 'receipt',
        label: '証憑回収率',
        value: `${client.receipt}%`,
        sublabel: '不足',
        subvalue: `${client.missing}件`,
      },
      {
        key: 'rejected',
        label: '差戻し中',
        value: `${rejected || client.diff}`,
        sublabel: '自動作成',
        subvalue: `${client.matches}件`,
      },
    ];

    return {
      clientId: client.id,
      mode: client.mode === 'yearend' ? 'yearend' : 'monthly',
      cards,
      pendingByChannel: await pendingByChannel(),
      vendorSyncOkRate: status.okRate,
    };
  }

  // global aggregate (no clientId given)
  const allClients = await prisma.client.findMany({
    select: {
      progress: true,
      receipt: true,
      missing: true,
      diff: true,
      tasks: { select: { stage: true } },
    },
  });
  const total = allClients.length || 1;
  const avgProgress = Math.round(allClients.reduce((a, c) => a + c.progress, 0) / total);
  const avgReceipt = Math.round(allClients.reduce((a, c) => a + c.receipt, 0) / total);
  const totalMissing = allClients.reduce((a, c) => a + c.missing, 0);
  const totalAwaiting = allClients.reduce(
    (a, c) => a + c.tasks.filter((t) => t.stage === 'awaiting_approval').length,
    0,
  );
  const totalRejected = allClients.reduce(
    (a, c) => a + c.tasks.filter((t) => t.stage === 'rejected').length,
    0,
  );

  return {
    mode: 'monthly',
    cards: [
      { key: 'progress', label: 'レビュー完了率', value: `${avgProgress}%` },
      { key: 'awaiting', label: '所長確認待ち', value: `${totalAwaiting}` },
      { key: 'receipt', label: '証憑回収率', value: `${avgReceipt}%`, sublabel: '不足合計', subvalue: `${totalMissing}件` },
      { key: 'rejected', label: '差戻し中', value: `${totalRejected}` },
    ],
    pendingByChannel: await pendingByChannel(),
    vendorSyncOkRate: status.okRate,
  };
}

async function pendingByChannel(): Promise<Record<string, number>> {
  const rows = await prisma.thread.findMany({
    where: { direction: 'out', status: 'queued' },
    select: { channel: true },
  });
  const acc: Record<string, number> = { email: 0, slack: 0, chatwork: 0, line_works: 0 };
  for (const r of rows) {
    acc[r.channel] = (acc[r.channel] ?? 0) + 1;
  }
  return acc;
}
