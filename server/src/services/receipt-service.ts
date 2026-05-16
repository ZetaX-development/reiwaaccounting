import { prisma } from '../lib/prisma.js';

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
  const [client, entries, policies] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: { receiptPolicyOverrides: true },
    }),
    prisma.entry.findMany({
      where: { clientId },
      orderBy: { occurredAt: 'desc' },
    }),
    prisma.receiptPolicy.findMany(),
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

  const missing: MissingReceipt[] = [];
  for (const e of entries) {
    if (e.requestedAt) continue; // already requested → hide
    const policy = mergePolicy(policyByAccount[e.account], overrides[e.account]);
    if (!policy.requiresReceipt) continue;
    if (policy.exemptUnder && e.amount < policy.exemptUnder) continue;
    if (e.receiptStatus === 'matched') continue;
    if (e.receiptStatus === 'na') continue;
    const reason =
      e.receiptStatus === 'partial' ? '一部のみ添付' : '領収書未添付';
    missing.push({
      entryId: e.id,
      account: e.account,
      amount: e.amount,
      vendor: extractVendor(e.description),
      occurredAt: e.occurredAt,
      reason,
      priority: e.score ?? 50,
      source: e.source,
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
