/**
 * Spec 24: キャッシュフロー予測
 */
import OpenAI from 'openai';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getLiveMfEntries } from './client-service.js';
import type { RawEntry } from '../adapters/vendor-adapter.js';

const INCOME_KEYWORDS = ['売上', '受取', '雑収入', '収入', '入金'];
const EXPENSE_KEYWORDS = ['仕入', '給与', '外注', '地代', '家賃', '水道', '光熱', '通信', '交際', '消耗', '広告', '旅費', '交通', '保険', '修繕', '減価償却', '支払', '租税'];

function classifyAccount(account: string): 'income' | 'expense' | 'other' {
  if (INCOME_KEYWORDS.some((k) => account.includes(k))) return 'income';
  if (EXPENSE_KEYWORDS.some((k) => account.includes(k))) return 'expense';
  return 'other';
}

interface MonthlyData { month: string; inflow: number; outflow: number; net: number; }

function toYYYYMM(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function aggregateByMonth(entries: RawEntry[]): MonthlyData[] {
  const map = new Map<string, { inflow: number; outflow: number }>();
  for (const e of entries) {
    const month = toYYYYMM(e.occurredAt);
    const existing = map.get(month) ?? { inflow: 0, outflow: 0 };
    const cls = classifyAccount(e.account);
    if (cls === 'income') existing.inflow += e.amount;
    else if (cls === 'expense') existing.outflow += e.amount;
    map.set(month, existing);
  }
  return Array.from(map.entries())
    .map(([month, data]) => ({ month, inflow: data.inflow, outflow: data.outflow, net: data.inflow - data.outflow }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function addMonths(yyyymm: string, n: number): string {
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(y!, m! - 1 + n, 1);
  return toYYYYMM(d);
}

function predictNextMonths(actual: MonthlyData[], count: number): MonthlyData[] {
  if (actual.length === 0) return [];
  const windowSize = Math.min(3, actual.length);
  const recent = actual.slice(-windowSize);
  const avgInflow = Math.round(recent.reduce((s, m) => s + m.inflow, 0) / windowSize);
  const avgOutflow = Math.round(recent.reduce((s, m) => s + m.outflow, 0) / windowSize);
  const lastMonth = actual[actual.length - 1]!.month;
  return Array.from({ length: count }, (_, i) => {
    const month = addMonths(lastMonth, i + 1);
    return { month, inflow: avgInflow, outflow: avgOutflow, net: avgInflow - avgOutflow };
  });
}

async function generateComment(actual: MonthlyData[], forecast: MonthlyData[], clientName: string): Promise<string> {
  if (!env.OPENAI_API_KEY || actual.length === 0) {
    const net = forecast[0]?.net ?? 0;
    return net >= 0 ? '過去の実績に基づいた予測です。収支はプラス傾向です。' : '支出が収入を上回る月があります。資金繰りにご注意ください。';
  }
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const prompt = `顧問先${clientName}のCF予測について税理士として2〜3文でコメントしてください。実績:${JSON.stringify(actual.slice(-3))} 予測:${JSON.stringify(forecast)} 平文のみで返してください。`;
  try {
    const res = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 200 });
    return res.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    logger.warn({ err }, 'cashflow AI comment failed');
    return '';
  }
}

export interface CashFlowResult { actual: MonthlyData[]; forecast: MonthlyData[]; aiComment: string; }

export async function buildCashFlowForecast(clientId: string, firmId: string): Promise<CashFlowResult> {
  const clientRow = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
  if (!clientRow) throw new Error('client not found');
  const since = new Date(); since.setMonth(since.getMonth() - 6);
  const liveEntries: RawEntry[] = await getLiveMfEntries(clientId);
  let entries: RawEntry[] = liveEntries;
  if (entries.length === 0) {
    const dbEntries = await prisma.entry.findMany({
      where: { clientId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'asc' },
      select: { account: true, description: true, amount: true, occurredAt: true, sourceEntryId: true },
    });
    entries = dbEntries.map((e) => ({
      sourceEntryId: e.sourceEntryId ?? '',
      account: e.account, description: e.description, amount: e.amount,
      occurredAt: e.occurredAt,
    }));
  }
  const filtered = entries.filter((e) => e.occurredAt >= since);
  const actual = aggregateByMonth(filtered);
  const forecast = predictNextMonths(actual, 3);
  const aiComment = await generateComment(actual, forecast, clientRow.name);
  for (const m of actual) {
    await prisma.cashFlowForecast.upsert({
      where: { clientId_forecastMonth: { clientId, forecastMonth: m.month } },
      update: { inflow: m.inflow, outflow: m.outflow, net: m.net, isActual: true },
      create: { firmId, clientId, forecastMonth: m.month, inflow: m.inflow, outflow: m.outflow, net: m.net, isActual: true },
    });
  }
  for (const m of forecast) {
    await prisma.cashFlowForecast.upsert({
      where: { clientId_forecastMonth: { clientId, forecastMonth: m.month } },
      update: { inflow: m.inflow, outflow: m.outflow, net: m.net, aiComment, isActual: false },
      create: { firmId, clientId, forecastMonth: m.month, inflow: m.inflow, outflow: m.outflow, net: m.net, aiComment, isActual: false },
    });
  }
  return { actual, forecast, aiComment };
}

export async function getCashFlowForecast(clientId: string, firmId: string): Promise<CashFlowResult> {
  const rows = await prisma.cashFlowForecast.findMany({
    where: { clientId, firmId },
    orderBy: { forecastMonth: 'asc' },
    select: { forecastMonth: true, inflow: true, outflow: true, net: true, aiComment: true, isActual: true },
  });
  if (rows.length === 0) return buildCashFlowForecast(clientId, firmId);
  const actual = rows.filter((r) => r.isActual).map((r) => ({ month: r.forecastMonth, inflow: r.inflow, outflow: r.outflow, net: r.net }));
  const forecast = rows.filter((r) => !r.isActual).map((r) => ({ month: r.forecastMonth, inflow: r.inflow, outflow: r.outflow, net: r.net }));
  const aiComment = rows.find((r) => !r.isActual)?.aiComment ?? '';
  return { actual, forecast, aiComment };
}
