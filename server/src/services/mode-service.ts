import { prisma } from '../lib/prisma.js';

const DEFAULT_YEAREND_CHECKS: Array<{ title: string; note?: string }> = [
  { title: '減価償却費の月割計算', note: '車両運搬具の取得月確認' },
  { title: '棚卸資産の実地棚卸', note: '期末時点で未提出の場合は催促' },
  { title: '貸倒引当金の見積', note: '繰入限度額試算' },
  { title: '未払費用の計上', note: '期末未払 (給与・社保・利息) 漏れ確認' },
  { title: '消費税の確定計算', note: '本則/簡易の判定' },
  { title: '税効果会計の繰延税金', note: '一時差異の集計' },
];

export async function setClientMode(clientId: string, mode: 'monthly' | 'yearend') {
  const client = await prisma.client.update({
    where: { id: clientId },
    data: { mode },
  });

  // If switching to yearend and no checklist exists, seed defaults.
  if (mode === 'yearend') {
    const count = await prisma.yearendCheck.count({ where: { clientId } });
    if (count === 0) {
      let order = 0;
      for (const c of DEFAULT_YEAREND_CHECKS) {
        order += 1;
        await prisma.yearendCheck.create({
          data: {
            firmId: 'demo-firm',
            clientId,
            title: c.title,
            note: c.note,
            status: 'open',
            order,
          },
        });
      }
    }
    // Compute initial yearendKpi
    await recomputeYearendKpi(clientId);
  }
  return client;
}

export async function listYearendChecklist(clientId: string) {
  return prisma.yearendCheck.findMany({
    where: { clientId },
    orderBy: { order: 'asc' },
  });
}

export async function updateYearendCheck(
  id: string,
  data: { status?: string; note?: string | null },
) {
  const updated = await prisma.yearendCheck.update({ where: { id }, data });
  await recomputeYearendKpi(updated.clientId);
  return updated;
}

export async function recomputeYearendKpi(clientId: string) {
  const [client, checks, entries] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.yearendCheck.findMany({ where: { clientId } }),
    prisma.entry.findMany({
      where: { clientId },
      select: { occurredAt: true },
    }),
  ]);
  if (!client) return null;
  const monthsSeen = new Set<string>();
  for (const e of entries) {
    const m = e.occurredAt.toISOString().slice(0, 7);
    monthsSeen.add(m);
  }
  const monthsTotal = 12;
  const monthsCovered = Math.min(monthsTotal, monthsSeen.size);
  const adjustmentChecks = checks.length;
  const adjustmentDone = checks.filter((c) => c.status === 'done').length;
  const filingReadiness =
    Math.round(
      (monthsCovered / monthsTotal) * 50 +
        (adjustmentChecks > 0 ? (adjustmentDone / adjustmentChecks) * 50 : 0),
    );
  const yearendKpi = {
    monthsCovered,
    monthsTotal,
    adjustmentChecks,
    adjustmentDone,
    filingReadiness,
  };
  await prisma.client.update({
    where: { id: clientId },
    data: { yearendKpi },
  });
  return yearendKpi;
}

export async function listClientModes() {
  return prisma.client.findMany({
    select: { id: true, name: true, mode: true, fiscalYearEnd: true },
    orderBy: { name: 'asc' },
  });
}
