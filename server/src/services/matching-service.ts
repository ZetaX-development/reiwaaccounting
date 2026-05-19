import { prisma } from '../lib/prisma.js';
import { getLiveMfEntries } from './client-service.js';

export type MatchStatus = 'matched' | 'unmatched' | 'no_client' | 'no_data';

export interface MatchResult {
  status: MatchStatus;
  matchedEntryId: string | null;
}

export async function findMatchForVoucher(
  voucherId: string,
): Promise<MatchResult> {
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { clientId: true, ocrJson: true },
  });
  if (!v) return { status: 'unmatched', matchedEntryId: null };
  if (!v.clientId) return { status: 'no_client', matchedEntryId: null };
  const j =
    (v.ocrJson as
      | { amount?: number | null; issue_date?: string | null }
      | null) ?? null;
  if (!j || j.amount == null || !j.issue_date) {
    return { status: 'no_data', matchedEntryId: null };
  }
  const entries = await getLiveMfEntries(v.clientId);
  const voucherDate = new Date(j.issue_date);
  const candidates = entries
    .filter((e) => e.amount === j.amount)
    .map((e) => ({
      entry: e,
      dayDiff: Math.abs(
        Math.round(
          (e.occurredAt.getTime() - voucherDate.getTime()) / 86400000,
        ),
      ),
    }))
    .filter((c) => c.dayDiff <= 30)
    .sort((a, b) => a.dayDiff - b.dayDiff);
  if (candidates.length === 0) {
    return { status: 'unmatched', matchedEntryId: null };
  }
  return {
    status: 'matched',
    matchedEntryId: candidates[0].entry.sourceEntryId,
  };
}
