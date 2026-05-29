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
  resolveClientToken,
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

class MfWriteFailure extends Error {
  userMessage: string;
  debugDetail: string;

  constructor(userMessage: string, debugDetail?: string) {
    super(userMessage);
    this.userMessage = userMessage;
    this.debugDetail = debugDetail ?? userMessage;
  }
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
    const externalId = voucher.client.mfExternalId ?? `mock-${voucher.clientId}`;
    const resolved = await resolveClientToken(externalId);
    if (!resolved.ok || !resolved.token) {
      throw new MfWriteFailure(
        resolved.error ?? 'MFアクセストークンがありません。OAuth連携を確認してください。',
        `token_resolve_failed externalId=${externalId} reason=${resolved.error ?? 'unknown'}`,
      );
    }
    const token = resolved.token;

    // 勘定科目名 → ID マップを取得
    const accountMap = await fetchAccountMap(token);
    if (accountMap.size === 0) {
      throw new MfWriteFailure(
        'MF勘定科目の取得に失敗しました。再度お試しください。',
        `account_map_empty externalId=${externalId}`,
      );
    }

    const debitId = accountMap.get(draft.debit.account);
    const creditId = accountMap.get(draft.credit.account);

    if (!debitId) {
      throw new MfWriteFailure(
        `借方勘定科目「${draft.debit.account}」がMFに見つかりません`,
        `missing_debit_account name=${draft.debit.account} externalId=${externalId}`,
      );
    }
    if (!creditId) {
      throw new MfWriteFailure(
        `貸方勘定科目「${draft.credit.account}」がMFに見つかりません`,
        `missing_credit_account name=${draft.credit.account} externalId=${externalId}`,
      );
    }

    const result = await createJournalEntry(externalId, {
      transactionDate: draft.transactionDate ?? new Date().toISOString().slice(0, 10),
      debitAccountId: debitId,
      creditAccountId: creditId,
      amount: draft.debit.amount ?? 0,
      description: draft.description ?? '',
      debitTaxName: draft.debit.taxClass,
    }, { token });

    if (!result.ok) {
      const rawError = result.error ?? '仕訳作成APIが失敗しました';
      const likelyScopeError = /403|scope|権限/i.test(rawError);
      if (likelyScopeError) {
        throw new MfWriteFailure(
          'MFへの書き込み権限が不足しています。MoneyForward連携をやり直してください（journal.write が必要です）。',
          `journal_write_permission_error externalId=${externalId} detail=${rawError}`,
        );
      }
      throw new MfWriteFailure(
        '仕訳作成APIが失敗しました。しばらくしてから再試行してください。',
        `journal_create_failed externalId=${externalId} detail=${rawError}`,
      );
    }

    logger.info({ voucherId, journalId: result.journalId }, 'mf journal created');
    await updateAndNotify(voucherId, 'done', undefined, voucher.lineUserId);
  } catch (err) {
    const failure = toMfWriteFailure(err);
    logger.error({ err, voucherId }, 'writeJournalToMf failed');
    await updateAndNotify(
      voucherId,
      'failed',
      failure.userMessage.slice(0, 400),
      voucher.lineUserId,
      failure.debugDetail.slice(0, 2000),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateAndNotify(
  voucherId: string,
  status: 'done' | 'failed',
  userErrorMsg: string | undefined,
  lineUserId: string | null | undefined,
  debugErrorMsg?: string,
): Promise<void> {
  await prisma.voucher.update({
    where: { id: voucherId },
    data: {
      mfWriteStatus: status,
      mfWriteError: debugErrorMsg ?? userErrorMsg ?? null,
      mfWriteAt: new Date(),
    },
  });

  if (!lineUserId || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return;

  const text =
    status === 'done'
      ? 'MoneyForwardへの仕訳入力が完了しました ✅'
      : `MoneyForwardへの入力に失敗しました ❌\n${userErrorMsg ?? ''}`;

  await lineService.pushMessage(lineUserId, [{ type: 'text', text }]);
}

function toMfWriteFailure(err: unknown): MfWriteFailure {
  if (err instanceof MfWriteFailure) return err;
  if (err instanceof Error) {
    return new MfWriteFailure(
      'MoneyForward連携で想定外エラーが発生しました。時間をおいて再試行してください。',
      `${err.name}: ${err.message}`,
    );
  }
  return new MfWriteFailure(
    'MoneyForward連携で想定外エラーが発生しました。時間をおいて再試行してください。',
    String(err),
  );
}
