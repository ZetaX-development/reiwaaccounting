/**
 * 期間配分（未払費用・前払費用）候補検出サービス
 * MF エントリから期末に計上すべき候補を検出する
 */
import { prisma } from '../lib/prisma.js';
import { getLiveMfEntries } from './client-service.js';
import type { RawEntry } from '../adapters/vendor-adapter.js';

export interface AccrualCandidate {
  type: 'unpaid' | 'prepaid'; // 未払費用 or 前払費用
  description: string;         // 元エントリの摘要
  amount: number;
  originalDate: string;        // 元の取引日
  suggestedAccount: string;    // 提案勘定科目
  reason: string;              // 判断理由
  entryId?: string;
}

// 未払費用候補となる借方勘定科目
const UNPAID_DEBIT_ACCOUNTS = ['地代家賃', 'リース料', '保険料', '維持費', '修繕費', '管理費'];

// 前払費用候補となる借方勘定科目
const PREPAID_DEBIT_ACCOUNTS = ['保険料', '地代家賃', '通信費', 'リース料', 'ソフトウェア使用料', '新聞図書費'];

// 未払費用 - 定期支払いを示す摘要キーワード
const MONTHLY_KEYWORDS = ['月次', '月額', '毎月', '定期'];

// 前払費用 - 年払い・前払いを示す摘要キーワード
const PREPAID_KEYWORDS = ['年払', '年一括', '前払', '一年分', '12ヶ月分', '12か月分', '年間'];

// 未払費用の金額下限
const UNPAID_AMOUNT_THRESHOLD = 50_000;

/**
 * 取引日が fiscalYearEnd の月に含まれるか判定する
 */
function isInFiscalEndMonth(occurredAt: Date, fiscalYearEnd: string): boolean {
  const endDate = new Date(fiscalYearEnd);
  return (
    occurredAt.getFullYear() === endDate.getFullYear() &&
    occurredAt.getMonth() === endDate.getMonth()
  );
}

/**
 * 借方勘定科目がパターンに一致するか（部分一致）
 */
function matchesAccount(account: string, patterns: string[]): boolean {
  return patterns.some((p) => account.includes(p));
}

/**
 * 摘要がキーワードを含むか
 */
function matchesKeywords(description: string, keywords: string[]): boolean {
  return keywords.some((k) => description.includes(k));
}

/**
 * 未払費用候補を検出する
 */
function detectUnpaid(entries: RawEntry[], fiscalYearEnd: string): AccrualCandidate[] {
  const candidates: AccrualCandidate[] = [];

  for (const entry of entries) {
    const { account, description, amount, occurredAt } = entry;

    if (!matchesAccount(account, UNPAID_DEBIT_ACCOUNTS)) continue;
    if (amount < UNPAID_AMOUNT_THRESHOLD) continue;
    if (!matchesKeywords(description, MONTHLY_KEYWORDS)) continue;
    if (!isInFiscalEndMonth(occurredAt, fiscalYearEnd)) continue;

    candidates.push({
      type: 'unpaid',
      description,
      amount,
      originalDate: occurredAt.toISOString().slice(0, 10),
      suggestedAccount: '未払費用',
      reason: `勘定科目「${account}」の定期支払い（${amount.toLocaleString('ja-JP')}円）が年度末月に計上されています。翌月分として未払費用への振替を検討してください。`,
    });
  }

  return candidates;
}

/**
 * 前払費用候補を検出する
 */
function detectPrepaid(entries: RawEntry[]): AccrualCandidate[] {
  const candidates: AccrualCandidate[] = [];

  for (const entry of entries) {
    const { account, description, amount, occurredAt } = entry;

    if (!matchesAccount(account, PREPAID_DEBIT_ACCOUNTS)) continue;
    if (!matchesKeywords(description, PREPAID_KEYWORDS)) continue;

    candidates.push({
      type: 'prepaid',
      description,
      amount,
      originalDate: occurredAt.toISOString().slice(0, 10),
      suggestedAccount: '前払費用',
      reason: `勘定科目「${account}」の年払い・前払い支出（${amount.toLocaleString('ja-JP')}円）が検出されました。翌期分は前払費用として按分計上を検討してください。`,
    });
  }

  return candidates;
}

/**
 * 期間配分候補（未払費用・前払費用）を検出する
 *
 * MF ライブAPIを優先し、取得できない場合は DB にフォールバックする
 */
export async function detectAccrualCandidates(
  clientId: string,
  firmId: string,
  fiscalYearEnd: string, // YYYY-MM-DD
): Promise<AccrualCandidate[]> {
  // ライブAPI優先取得（CLAUDE.md「ライブ取得」原則）
  let entries: RawEntry[] = await getLiveMfEntries(clientId);

  // ライブ取得できない場合は DB フォールバック
  if (entries.length === 0) {
    const dbEntries = await prisma.entry.findMany({
      where: { clientId, firmId },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      select: {
        account: true,
        description: true,
        amount: true,
        occurredAt: true,
        sourceEntryId: true,
      },
    });
    entries = dbEntries.map((e) => ({
      sourceEntryId: e.sourceEntryId ?? '',
      account: e.account,
      description: e.description,
      amount: e.amount,
      occurredAt: e.occurredAt,
    }));
  }

  const unpaidCandidates = detectUnpaid(entries, fiscalYearEnd);
  const prepaidCandidates = detectPrepaid(entries);

  return [...unpaidCandidates, ...prepaidCandidates];
}
