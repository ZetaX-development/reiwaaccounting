/**
 * Spec 25: 顧問先ポータル
 */
import { prisma } from '../lib/prisma.js';
import { getLiveMfEntries } from './client-service.js';
import type { RawEntry } from '../adapters/vendor-adapter.js';

export async function getOrCreatePortalToken(clientId: string, firmId: string): Promise<string> {
  const existing = await prisma.clientPortal.findUnique({ where: { clientId }, select: { token: true, enabled: true } });
  if (existing?.enabled) return existing.token;
  if (existing) {
    const updated = await prisma.clientPortal.update({ where: { clientId }, data: { enabled: true }, select: { token: true } });
    return updated.token;
  }
  const created = await prisma.clientPortal.create({ data: { firmId, clientId }, select: { token: true } });
  return created.token;
}

export async function disablePortalToken(clientId: string, firmId: string): Promise<boolean> {
  const existing = await prisma.clientPortal.findFirst({ where: { clientId, firmId }, select: { id: true } });
  if (!existing) return false;
  await prisma.clientPortal.update({ where: { id: existing.id }, data: { enabled: false } });
  return true;
}

const INCOME_KEYWORDS = ['売上', '受取', '雑収入', '収入'];
const EXPENSE_KEYWORDS = ['仕入', '給与', '外注', '家賃', '水道', '光熱', '通信', '交際', '消耗', '広告', '旅費', '減価償却', '支払', '保険'];

function classifyEntry(account: string): 'income' | 'expense' | 'other' {
  if (INCOME_KEYWORDS.some((k) => account.includes(k))) return 'income';
  if (EXPENSE_KEYWORDS.some((k) => account.includes(k))) return 'expense';
  return 'other';
}

interface MonthlyPl { month: string; income: number; expense: number; profit: number; }
interface TopAccount { account: string; amount: number; }

function buildMonthlyPl(entries: RawEntry[]): MonthlyPl[] {
  const map = new Map<string, { income: number; expense: number }>();
  for (const e of entries) {
    const month = `${e.occurredAt.getFullYear()}-${String(e.occurredAt.getMonth() + 1).padStart(2, '0')}`;
    const existing = map.get(month) ?? { income: 0, expense: 0 };
    const cls = classifyEntry(e.account);
    if (cls === 'income') existing.income += e.amount;
    else if (cls === 'expense') existing.expense += e.amount;
    map.set(month, existing);
  }
  return Array.from(map.entries())
    .map(([month, data]) => ({ month, income: data.income, expense: data.expense, profit: data.income - data.expense }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function topAccounts(entries: RawEntry[], type: 'income' | 'expense', limit: number): TopAccount[] {
  const map = new Map<string, number>();
  for (const e of entries) { if (classifyEntry(e.account) === type) map.set(e.account, (map.get(e.account) ?? 0) + e.amount); }
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([account, amount]) => ({ account, amount }));
}

export interface PortalReport {
  clientName: string; reportMonth: string; generatedAt: string;
  monthlyPl: MonthlyPl[]; topIncome: TopAccount[]; topExpense: TopAccount[];
  currentMonthSummary: { income: number; expense: number; profit: number; profitMargin: number | null };
}

export async function getPortalReport(token: string): Promise<PortalReport | null> {
  const portal = await prisma.clientPortal.findUnique({ where: { token }, select: { clientId: true, firmId: true, enabled: true, id: true } });
  if (!portal?.enabled) return null;
  await prisma.clientPortal.update({ where: { id: portal.id }, data: { lastViewedAt: new Date() } });
  const clientRow = await prisma.client.findUnique({ where: { id: portal.clientId }, select: { name: true } });
  if (!clientRow) return null;
  const liveEntries: RawEntry[] = await getLiveMfEntries(portal.clientId);
  let entries: RawEntry[] = liveEntries;
  if (entries.length === 0) {
    const dbEntries = await prisma.entry.findMany({
      where: { clientId: portal.clientId },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      select: { account: true, description: true, amount: true, occurredAt: true, sourceEntryId: true },
    });
    entries = dbEntries.map((e) => ({
      sourceEntryId: e.sourceEntryId ?? '',
      account: e.account, description: e.description, amount: e.amount,
      occurredAt: e.occurredAt,
    }));
  }
  const monthlyPl = buildMonthlyPl(entries);
  const currentMonth = monthlyPl[monthlyPl.length - 1] ?? { income: 0, expense: 0, profit: 0 };
  const now = new Date();
  return {
    clientName: clientRow.name,
    reportMonth: `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`,
    generatedAt: now.toISOString(),
    monthlyPl, topIncome: topAccounts(entries, 'income', 5), topExpense: topAccounts(entries, 'expense', 5),
    currentMonthSummary: { income: currentMonth.income, expense: currentMonth.expense, profit: currentMonth.profit, profitMargin: currentMonth.income > 0 ? Math.round((currentMonth.profit / currentMonth.income) * 100) : null },
  };
}
