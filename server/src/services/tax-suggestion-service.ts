/**
 * Spec 23: AI節税提案エンジン
 */
import OpenAI from 'openai';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getLiveMfEntries } from './client-service.js';
import type { RawEntry } from '../adapters/vendor-adapter.js';

const ENTERTAINMENT_ACCOUNTS = ['交際費', '接待交際費', '会議費'];
const OFFICER_ACCOUNTS = ['役員報酬', '役員給与'];
const DEPRECIATION_ACCOUNTS = ['減価償却費', '消耗品費', '器具備品'];

interface AccountSummary {
  account: string;
  totalAmount: number;
  count: number;
  examples: string[];
}

function summarizeEntries(entries: RawEntry[]): AccountSummary[] {
  const map = new Map<string, AccountSummary>();
  for (const e of entries) {
    const existing = map.get(e.account);
    if (existing) {
      existing.totalAmount += e.amount;
      existing.count += 1;
      if (existing.examples.length < 3) existing.examples.push(e.description);
    } else {
      map.set(e.account, { account: e.account, totalAmount: e.amount, count: 1, examples: [e.description] });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
}

export interface TaxSuggestionItem {
  category: string;
  title: string;
  detail: string;
  estimatedSaving: number | null;
  priority: 'high' | 'medium' | 'low';
}

async function analyzeWithAI(summaries: AccountSummary[], clientName: string, industry: string): Promise<TaxSuggestionItem[]> {
  if (!env.OPENAI_API_KEY) return generateRuleBasedSuggestions(summaries);
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const top = summaries.slice(0, 15).map((s) => ({ 勘定科目: s.account, 合計金額: s.totalAmount, 件数: s.count }));
  const prompt = `税理士AIとして、以下の顧問先（${clientName}、${industry}）の仕訳データを分析し節税提案を最大5件生成してください。\n\n勘定科目集計:\n${JSON.stringify(top)}\n\n以下のJSON形式で返してください（キーは"suggestions"）:\n{"suggestions":[{"category":"entertainment|depreciation|timing|officer_salary|tax_method|other","title":"タイトル20文字以内","detail":"詳細100文字以内","estimatedSaving":数値かnull,"priority":"high|medium|low"}]}`;
  try {
    const res = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 1000 });
    const raw = res.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { suggestions?: TaxSuggestionItem[] };
    return (parsed.suggestions ?? []).slice(0, 5);
  } catch (err) {
    logger.warn({ err }, 'tax suggestion AI failed');
    return generateRuleBasedSuggestions(summaries);
  }
}

function generateRuleBasedSuggestions(summaries: AccountSummary[]): TaxSuggestionItem[] {
  const suggestions: TaxSuggestionItem[] = [];
  const entertainment = summaries.find((s) => ENTERTAINMENT_ACCOUNTS.some((a) => s.account.includes(a)));
  if (entertainment && entertainment.totalAmount > 100_000) {
    suggestions.push({ category: 'entertainment', title: '交際費 vs 会議費の見直し', detail: `交際費が¥${entertainment.totalAmount.toLocaleString('ja-JP')}計上されています。1人5,000円以下は会議費として全額損金算入可能です。`, estimatedSaving: Math.floor(entertainment.totalAmount * 0.15), priority: 'high' });
  }
  const consumables = summaries.find((s) => DEPRECIATION_ACCOUNTS.some((a) => s.account.includes(a)));
  if (consumables && consumables.totalAmount > 300_000) {
    suggestions.push({ category: 'depreciation', title: '少額減価償却の活用', detail: '30万円未満の固定資産は中小企業特例により一括損金算入できます。現在の計上状況を確認してください。', estimatedSaving: null, priority: 'medium' });
  }
  const officer = summaries.find((s) => OFFICER_ACCOUNTS.some((a) => s.account.includes(a)));
  if (officer) {
    suggestions.push({ category: 'officer_salary', title: '役員報酬の期初最適化', detail: '役員報酬は期首から3ヶ月以内に決定が必要です。現在の利益水準に合わせた最適額を期初に設定することで節税効果が生まれます。', estimatedSaving: null, priority: 'medium' });
  }
  if (suggestions.length === 0) {
    suggestions.push({ category: 'other', title: '仕訳データを蓄積してください', detail: 'MFと連携して3ヶ月以上の仕訳データが揃うと、より精度の高い節税提案が生成されます。', estimatedSaving: null, priority: 'low' });
  }
  return suggestions;
}

export interface AnalyzeResult {
  generated: number;
  suggestions: Array<{ id: string; category: string; title: string; detail: string; estimatedSaving: number | null; priority: string; status: string }>;
}

export async function analyzeTaxSuggestions(clientId: string, firmId: string): Promise<AnalyzeResult> {
  const clientRow = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true, industry: true } });
  if (!clientRow) throw new Error('client not found');
  const liveEntries: RawEntry[] = await getLiveMfEntries(clientId);
  let entries: RawEntry[] = liveEntries;
  if (entries.length === 0) {
    const dbEntries = await prisma.entry.findMany({ where: { clientId }, orderBy: { occurredAt: 'desc' }, take: 500, select: { account: true, description: true, amount: true, occurredAt: true, receiptStatus: true, sourceEntryId: true } });
    entries = dbEntries.map((e) => ({ sourceEntryId: e.sourceEntryId ?? '', account: e.account, description: e.description, amount: e.amount, occurredAt: e.occurredAt }));
  }
  const summaries = summarizeEntries(entries);
  const aiItems = await analyzeWithAI(summaries, clientRow.name, clientRow.industry);
  await prisma.taxSuggestion.deleteMany({ where: { clientId, firmId, status: 'open' } });
  const created = await prisma.$transaction(aiItems.map((item) => prisma.taxSuggestion.create({ data: { firmId, clientId, category: item.category, title: item.title, detail: item.detail, estimatedSaving: item.estimatedSaving, priority: item.priority, status: 'open' }, select: { id: true, category: true, title: true, detail: true, estimatedSaving: true, priority: true, status: true } })));
  return { generated: created.length, suggestions: created };
}

export async function listTaxSuggestions(clientId: string, firmId: string) {
  return prisma.taxSuggestion.findMany({ where: { clientId, firmId }, orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }], select: { id: true, category: true, title: true, detail: true, estimatedSaving: true, priority: true, status: true, analyzedAt: true } });
}

export async function updateTaxSuggestionStatus(id: string, firmId: string, status: 'open' | 'implemented' | 'dismissed'): Promise<boolean> {
  const existing = await prisma.taxSuggestion.findFirst({ where: { id, firmId }, select: { id: true } });
  if (!existing) return false;
  await prisma.taxSuggestion.update({ where: { id }, data: { status } });
  return true;
}
