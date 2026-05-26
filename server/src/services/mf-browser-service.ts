/**
 * mf-browser-service.ts — Spec 20 (API版)
 *
 * Playwright ブラウザ自動化から MF Cloud Accounting API (journal.write) に変更。
 * ブラウザログインは MF のセキュリティ検知（2FA要求）で失敗するため、
 * OAuth アクセストークンを使った API 書き込みに切り替えた。
 *
 * 前提: 該当クライアントが journal.write スコープ込みで OAuth 再認証済みであること。
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import * as lineService from './line-service.js';
import {
  fetchAccountMap,
  createJournalEntry,
} from '../adapters/mf-api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DraftJournalLine {
  account?: string;
  amount?: number;
  taxClass?: string | null;
}

interface DraftJournal {
  transactionDate?: string;
  debit?: DraftJournalLine;
  credit?: DraftJournalLine;
  description?: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * LINE の「はい」postback で呼ばれる。
 * Voucher に紐付いたクライアントの MF アクセストークンで仕訳を作成する。
 */
export async function writeJournalToMf(voucherId: string): Promise<void> {
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: {
      id: true,
      lineUserId: true,
      draftJournalJson: true,
      clientId: true,
      client: {
        select: { mfExternalId: true, mfAccessToken: true, name: true },
      },
    },
  });
  if (!voucher) return;

  // クライアントの MF 連携チェック
  if (!voucher.clientId || !voucher.client?.mfAccessToken) {
    const reason = !voucher.clientId
      ? '顧問先が未設定です。'
      : '顧問先のMoneyForward連携がありません。ダッシュボードからOAuth連携してください。';
    await updateAndNotify(voucherId, 'failed', reason, voucher.lineUserId);
    return;
  }

  const draft = (voucher.draftJournalJson ?? {}) as DraftJournal;
  if (!draft.debit?.account || !draft.credit?.account) {
    await updateAndNotify(voucherId, 'failed', '仕訳ドラフトの勘定科目が不完全です。', voucher.lineUserId);
    return;
  }

  await prisma.voucher.update({
    where: { id: voucherId },
    data: { mfWriteStatus: 'writing', mfWriteAt: new Date() },
  });

  try {
    // 勘定科目名 → ID マップを取得
    const externalId = voucher.client.mfExternalId ?? `mock-${voucher.clientId}`;
    const accountMap = await fetchAccountMap(voucher.client.mfAccessToken);

    const debitId = accountMap.get(draft.debit.account);
    const creditId = accountMap.get(draft.credit.account);

    if (!debitId) {
      throw new Error(`借方勘定科目「${draft.debit.account}」がMFに見つかりません`);
    }
    if (!creditId) {
      throw new Error(`貸方勘定科目「${draft.credit.account}」がMFに見つかりません`);
    }

    const result = await createJournalEntry(externalId, {
      transactionDate: draft.transactionDate ?? new Date().toISOString().slice(0, 10),
      debitAccountId: debitId,
      creditAccountId: creditId,
      amount: draft.debit.amount ?? 0,
      description: draft.description ?? '',
      debitTaxName: draft.debit.taxClass,
    });

    if (!result.ok) {
      throw new Error(result.error ?? '仕訳作成APIが失敗しました');
    }

    logger.info({ voucherId, journalId: result.journalId }, 'mf journal created');
    await updateAndNotify(voucherId, 'done', undefined, voucher.lineUserId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, voucherId }, 'writeJournalToMf failed');
    await updateAndNotify(voucherId, 'failed', msg.slice(0, 200), voucher.lineUserId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateAndNotify(
  voucherId: string,
  status: 'done' | 'failed',
  errorMsg: string | undefined,
  lineUserId: string | null | undefined,
): Promise<void> {
  await prisma.voucher.update({
    where: { id: voucherId },
    data: {
      mfWriteStatus: status,
      mfWriteError: errorMsg ?? null,
      mfWriteAt: new Date(),
    },
  });

  if (!lineUserId || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return;

  const text =
    status === 'done'
      ? 'MoneyForwardへの仕訳入力が完了しました ✅'
      : `MoneyForwardへの入力に失敗しました ❌\n${errorMsg ?? ''}`;

  await lineService.pushMessage(lineUserId, [{ type: 'text', text }]);
}
