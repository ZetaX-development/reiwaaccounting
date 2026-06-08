/**
 * AR突合サービス（売上側記帳・突合）
 *
 * MF live data から売掛金エントリと入金エントリを抽出し、
 * 取引先と金額でマッチングして未回収の売掛金を検出する。
 */

import { getLiveMfEntries } from './client-service.js';
import { logger } from '../lib/logger.js';
import type { RawEntry } from '../adapters/vendor-adapter.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ArMatchingResult {
  unmatched: UnmatchedReceivable[];
  matched: MatchedReceivable[];
  summary: {
    totalUnmatchedAmount: number;
    totalMatchedAmount: number;
    unmatchedCount: number;
  };
}

export interface UnmatchedReceivable {
  entryId?: string;
  date: string;
  partner: string | null;
  amount: number;
  description: string;
  agingDays: number;
  agingCategory: 'current' | '30days' | '60days' | '90days+';
}

export interface MatchedReceivable {
  receivableDate: string;
  collectionDate: string;
  partner: string | null;
  amount: number;
}

// ---------------------------------------------------------------------------
// AR account name patterns
// ---------------------------------------------------------------------------

const AR_DEBIT_KEYWORDS = ['売掛金', '受取手形'];
const AR_CREDIT_KEYWORDS = ['売掛金'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * MF の raw JSON から貸方勘定科目名を取得する。
 * raw は MfJournal 型 (branches[].creditor.account_name) を期待する。
 */
function getCreditAccountName(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const j = raw as {
    branches?: { creditor?: { account_name?: string } }[];
  };
  return j.branches?.[0]?.creditor?.account_name ?? '';
}

/**
 * MF の raw JSON から取引先名を取得する。
 * debitor.trade_partner_name → creditor.trade_partner_name の順に参照する。
 */
function getPartnerName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as {
    branches?: {
      debitor?: { trade_partner_name?: string };
      creditor?: { trade_partner_name?: string };
    }[];
  };
  const branch = j.branches?.[0];
  return branch?.debitor?.trade_partner_name ?? branch?.creditor?.trade_partner_name ?? null;
}

/** 経過日数から agingCategory を決定する */
function toAgingCategory(agingDays: number): UnmatchedReceivable['agingCategory'] {
  if (agingDays <= 30) return 'current';
  if (agingDays <= 60) return '30days';
  if (agingDays <= 90) return '60days';
  return '90days+';
}

/** 2つの金額が ±5% の許容差内に収まるかを判定する */
function isAmountMatch(a: number, b: number): boolean {
  if (a === 0 && b === 0) return true;
  const larger = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / larger <= 0.05;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * 指定クライアントの売掛金エントリと入金エントリを突合する。
 *
 * データソース: MF live API（CLAUDE.md の「DB キャッシュではなくライブ取得」原則に従う）
 * MF トークンが未設定の場合は空の結果を返す（安全なフォールバック）。
 */
export async function matchArEntries(
  clientId: string,
  firmId: string,
): Promise<ArMatchingResult> {
  let liveEntries: RawEntry[] = [];
  try {
    liveEntries = await getLiveMfEntries(clientId);
  } catch (err) {
    logger.warn({ err, clientId, firmId }, 'ar-matching: getLiveMfEntries failed, returning empty result');
  }

  if (liveEntries.length === 0) {
    return buildEmptyResult();
  }

  // 売掛金エントリ: 借方勘定科目が「売掛金」または「受取手形」を含むもの
  const receivables = liveEntries.filter((e) =>
    AR_DEBIT_KEYWORDS.some((kw) => e.account.includes(kw)),
  );

  // 入金エントリ: 貸方勘定科目が「売掛金」を含むもの
  // （普通預金/当座預金 ← 売掛金 の回収仕訳）
  const collections = liveEntries.filter((e) => {
    const creditAccount = getCreditAccountName(e.raw);
    return AR_CREDIT_KEYWORDS.some((kw) => creditAccount.includes(kw));
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const matched: MatchedReceivable[] = [];
  const usedCollectionIndices = new Set<number>();

  // マッチング: 取引先（partner）と金額（±5%許容差）でペアリング
  const unmatchedReceivables: UnmatchedReceivable[] = [];

  for (const receivable of receivables) {
    const partner = getPartnerName(receivable.raw);
    let foundIndex = -1;

    for (let i = 0; i < collections.length; i++) {
      if (usedCollectionIndices.has(i)) continue;
      const collection = collections[i];
      const collectionPartner = getPartnerName(collection.raw);

      const partnerMatches =
        partner !== null && collectionPartner !== null
          ? partner === collectionPartner
          : partner === null && collectionPartner === null;

      if (partnerMatches && isAmountMatch(receivable.amount, collection.amount)) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex >= 0) {
      usedCollectionIndices.add(foundIndex);
      const collection = collections[foundIndex];
      matched.push({
        receivableDate: receivable.occurredAt.toISOString().slice(0, 10),
        collectionDate: collection.occurredAt.toISOString().slice(0, 10),
        partner,
        amount: receivable.amount,
      });
    } else {
      const entryDate = new Date(receivable.occurredAt);
      entryDate.setHours(0, 0, 0, 0);
      const agingDays = Math.floor((today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));

      unmatchedReceivables.push({
        entryId: receivable.sourceEntryId,
        date: receivable.occurredAt.toISOString().slice(0, 10),
        partner,
        amount: receivable.amount,
        description: receivable.description,
        agingDays,
        agingCategory: toAgingCategory(agingDays),
      });
    }
  }

  const totalUnmatchedAmount = unmatchedReceivables.reduce((sum, r) => sum + r.amount, 0);
  const totalMatchedAmount = matched.reduce((sum, r) => sum + r.amount, 0);

  return {
    unmatched: unmatchedReceivables,
    matched,
    summary: {
      totalUnmatchedAmount,
      totalMatchedAmount,
      unmatchedCount: unmatchedReceivables.length,
    },
  };
}

function buildEmptyResult(): ArMatchingResult {
  return {
    unmatched: [],
    matched: [],
    summary: {
      totalUnmatchedAmount: 0,
      totalMatchedAmount: 0,
      unmatchedCount: 0,
    },
  };
}
