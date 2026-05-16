import { prisma } from '../lib/prisma.js';
import { getLiveMfEntries } from './client-service.js';

export interface MissingReceipt {
  entryId: string;
  account: string;
  amount: number;
  vendor: string | null;
  occurredAt: Date;
  reason: string;
  priority: number;
  source: string;
}

interface PolicyMerged {
  requiresReceipt: boolean;
  requiresApproval: boolean;
  exemptUnder: number | null;
}

function mergePolicy(
  base: { requiresReceipt: boolean; requiresApproval: boolean; exemptUnder: number | null } | undefined,
  override: Partial<PolicyMerged> | undefined,
): PolicyMerged {
  return {
    requiresReceipt: override?.requiresReceipt ?? base?.requiresReceipt ?? false,
    requiresApproval: override?.requiresApproval ?? base?.requiresApproval ?? false,
    exemptUnder: override?.exemptUnder ?? base?.exemptUnder ?? null,
  };
}

export async function listReceiptPolicies() {
  return prisma.receiptPolicy.findMany({ orderBy: { account: 'asc' } });
}

export async function updateReceiptPolicy(
  account: string,
  data: Partial<{ requiresReceipt: boolean; requiresApproval: boolean; exemptUnder: number | null; notes: string | null }>,
) {
  return prisma.receiptPolicy.upsert({
    where: { account },
    update: data,
    create: { account, ...data },
  });
}

export async function updateClientReceiptOverrides(
  clientId: string,
  overrides: Record<string, Partial<PolicyMerged>>,
) {
  return prisma.client.update({
    where: { id: clientId },
    data: { receiptPolicyOverrides: overrides },
  });
}

export async function computeMissingReceipts(clientId: string): Promise<MissingReceipt[]> {
  const [client, dbEntries, policies, liveMf] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: { receiptPolicyOverrides: true, mfAccessToken: true },
    }),
    prisma.entry.findMany({
      where: { clientId },
      orderBy: { occurredAt: 'desc' },
    }),
    prisma.receiptPolicy.findMany(),
    getLiveMfEntries(clientId),
  ]);
  if (!client) return [];
  const policyByAccount: Record<string, { requiresReceipt: boolean; requiresApproval: boolean; exemptUnder: number | null }> = {};
  for (const p of policies) {
    policyByAccount[p.account] = {
      requiresReceipt: p.requiresReceipt,
      requiresApproval: p.requiresApproval,
      exemptUnder: p.exemptUnder ?? null,
    };
  }
  const overrides = (client.receiptPolicyOverrides ?? {}) as Record<string, Partial<PolicyMerged>>;

  // Normalise both sources (DB Entry rows + live MF RawEntry items) to a
  // single shape so the policy filter logic stays simple.
  type Candidate = {
    entryId: string;
    account: string;
    amount: number;
    description: string;
    occurredAt: Date;
    receiptStatus: string;
    score: number | null;
    source: string;
    requested: boolean;
  };

  const liveCandidates: Candidate[] = liveMf.map((e) => ({
    entryId: `live-mf-${e.sourceEntryId}`,
    account: e.account,
    amount: e.amount,
    description: e.description,
    occurredAt: e.occurredAt,
    receiptStatus: e.receiptStatus ?? 'na',
    score: null,
    source: 'mf',
    requested: false,
  }));

  // DB rows: for MF-connected clients drop DB rows whose source is 'mf'
  // (they would duplicate the live data). Keep freee / other sources.
  const dbCandidates: Candidate[] = dbEntries
    .filter((e) => !(client.mfAccessToken && e.source === 'mf'))
    .map((e) => ({
      entryId: e.id,
      account: e.account,
      amount: e.amount,
      description: e.description,
      occurredAt: e.occurredAt,
      receiptStatus: e.receiptStatus,
      score: e.score,
      source: e.source,
      requested: !!e.requestedAt,
    }));

  const all = [...liveCandidates, ...dbCandidates];
  const missing: MissingReceipt[] = [];
  for (const c of all) {
    if (c.requested) continue;
    const policy = mergePolicy(policyByAccount[c.account], overrides[c.account]);
    if (!policy.requiresReceipt) continue;
    if (policy.exemptUnder && c.amount < policy.exemptUnder) continue;
    if (c.receiptStatus === 'matched') continue;
    if (c.receiptStatus === 'na') continue;
    const reason =
      c.receiptStatus === 'partial' ? '一部のみ添付' : '領収書未添付';
    missing.push({
      entryId: c.entryId,
      account: c.account,
      amount: c.amount,
      vendor: extractVendor(c.description),
      occurredAt: c.occurredAt,
      reason,
      priority: c.score ?? 50,
      source: c.source,
    });
  }
  return missing.sort((a, b) => b.priority - a.priority);
}

function extractVendor(desc: string): string | null {
  // crude heuristic: first word/segment up to a number or 円
  const m = desc.match(/^([^0-9¥\s]+)/);
  return m ? m[1].trim() : null;
}

export async function markEntryNotRequired(entryId: string) {
  return prisma.entry.update({
    where: { id: entryId },
    data: { receiptStatus: 'na' },
  });
}

export interface ReceiptRequestPayload {
  subject: string;
  body: string;
  channel: string;
  originRef: string;
  entryIds: string[];
}

export async function generateReceiptRequest(
  clientId: string,
  entryIds: string[],
  channel: string,
): Promise<ReceiptRequestPayload> {
  const [client, entries] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.entry.findMany({ where: { id: { in: entryIds } } }),
  ]);
  if (!client) throw new Error('client not found');

  const lines = entries.map(
    (e) =>
      `・${e.account} ${e.description}（${e.occurredAt.toISOString().slice(0, 10)} / ¥${e.amount.toLocaleString('ja-JP')}）`,
  );
  const due = new Date(client.fiscalYearEnd);
  const subject = `${client.name} 様 月次資料のご確認のお願い`;
  const body =
    `${client.name} ご担当者様\n\nいつもお世話になっております。zeimeeでございます。\n` +
    `月次処理にあたり、下記資料のご共有をお願いいたします。\n\n${lines.join('\n')}\n\n` +
    `恐れ入りますが、${due.toISOString().slice(0, 10)}までにご対応いただけますと幸いです。\n` +
    `何卒よろしくお願い申し上げます。`;
  const originRef = 'rr_' + Date.now().toString(36);
  return { subject, body, channel, originRef, entryIds };
}

export async function markEntriesRequested(entryIds: string[]) {
  await prisma.entry.updateMany({
    where: { id: { in: entryIds } },
    data: { requestedAt: new Date() },
  });
}
