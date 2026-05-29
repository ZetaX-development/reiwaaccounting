/**
 * Spec 23: RAG仕訳AIレビューサービス
 *
 * 摘要(memo)が空のMF仕訳をRAGで補完する。
 * routing:
 * - auto_applied: localOnly=false の場合のみ MF に PUT
 * - pending: レビューキュー
 * - difficult: レビューキュー + Todo自動追加
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { mfApiAdapter } from '../adapters/mf-api.js';
import { updateJournalMemo } from '../adapters/mf-api.js';
import { generateMemoWithRag, type ClientHistoryExample } from './journal-rag-service.js';

interface MfJournalRaw {
  id: string;
  transaction_date: string;
  memo?: string;
  branches?: {
    debitor?: { account_name?: string; value?: number };
    creditor?: { account_name?: string; value?: number };
  }[];
}

export interface ProcessResult {
  total: number;
  autoApplied: number;
  pending: number;
  difficult: number;
  errors: number;
}

export async function processBlankMemoJournals(
  clientId: string,
  firmId: string,
  options?: { localOnly?: boolean },
): Promise<ProcessResult> {
  const localOnly = options?.localOnly === true;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { mfExternalId: true, mfAccessToken: true, industry: true },
  });
  if (!client?.mfAccessToken) {
    throw new Error('MF連携がされていません');
  }

  // 精度向上: 顧問先の承認済み仕訳履歴を取得（Few-shot例として使用）
  const approvedReviews = await prisma.journalAiReview.findMany({
    where: { clientId, status: 'approved' },
    select: { debitAccount: true, creditAccount: true, amount: true, aiMemo: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });
  const clientHistory: ClientHistoryExample[] = approvedReviews
    .filter((r) => r.debitAccount && r.creditAccount && r.aiMemo)
    .map((r) => ({
      debit: r.debitAccount!,
      credit: r.creditAccount!,
      amount: r.amount ?? 0,
      memo: r.aiMemo!,
    }));

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await mfApiAdapter.fetchEntries(client.mfExternalId ?? `mock-${clientId}`, since);
  const rawJournals: MfJournalRaw[] = result.items
    .map((e) => e.raw as MfJournalRaw)
    .filter((j, i, arr) => arr.findIndex((x) => x.id === j.id) === i);

  const blanks = rawJournals.filter((j) => !j.memo?.trim());

  const existing = await prisma.journalAiReview.findMany({
    where: { clientId },
    select: { mfJournalId: true },
  });
  const processedIds = new Set(existing.map((r) => r.mfJournalId));
  const targets = blanks.filter((j) => !processedIds.has(j.id));

  const stats: ProcessResult = {
    total: targets.length,
    autoApplied: 0,
    pending: 0,
    difficult: 0,
    errors: 0,
  };

  for (const j of targets) {
    const branch = j.branches?.[0];
    const debit = branch?.debitor?.account_name ?? '不明';
    const credit = branch?.creditor?.account_name ?? '不明';
    const amount = branch?.debitor?.value ?? 0;

    try {
      const ragResult = await generateMemoWithRag({
        debit,
        credit,
        amount,
        date: j.transaction_date,
        originalMemo: j.memo ?? '',
        clientIndustry: client.industry ?? undefined,
        clientHistory,
      });

      switch (ragResult.routing) {
        case 'auto_applied': {
          let status: 'auto_applied' | 'pending' = 'auto_applied';
          let errorMsg: string | null = null;

          if (!localOnly) {
            const externalId = client.mfExternalId ?? `mock-${clientId}`;
            const putResult = await updateJournalMemo(externalId, j.id, ragResult.memo);
            status = putResult.ok ? 'auto_applied' : 'pending';
            errorMsg = putResult.ok ? null : (putResult.error ?? 'MF_PUT_FAILED');
          }

          await prisma.journalAiReview.create({
            data: {
              firmId,
              clientId,
              mfJournalId: j.id,
              status,
              aiMemo: ragResult.memo,
              aiConfidence: ragResult.confidence,
              debitAccount: debit,
              creditAccount: credit,
              amount,
              transactionDate: j.transaction_date,
              originalMemo: j.memo ?? '',
              errorMsg,
            },
          });

          if (status === 'auto_applied') stats.autoApplied += 1;
          else stats.pending += 1;
          break;
        }

        case 'pending': {
          await prisma.journalAiReview.create({
            data: {
              firmId,
              clientId,
              mfJournalId: j.id,
              status: 'pending',
              aiMemo: ragResult.memo,
              aiConfidence: ragResult.confidence,
              debitAccount: debit,
              creditAccount: credit,
              amount,
              transactionDate: j.transaction_date,
              originalMemo: j.memo ?? '',
            },
          });
          stats.pending += 1;
          break;
        }

        case 'difficult': {
          await prisma.journalAiReview.create({
            data: {
              firmId,
              clientId,
              mfJournalId: j.id,
              status: 'difficult',
              aiMemo: ragResult.memo,
              aiConfidence: ragResult.confidence,
              debitAccount: debit,
              creditAccount: credit,
              amount,
              transactionDate: j.transaction_date,
              originalMemo: j.memo ?? '',
              errorMsg: ragResult.reasoning,
            },
          });

          await prisma.todo.create({
            data: {
              firmId,
              clientId,
              title: `AI判断困難: ${debit} / ${credit} ¥${amount.toLocaleString('ja-JP')}`,
              note: `仕訳日: ${j.transaction_date}\nAI理由: ${ragResult.reasoning}\nMF仕訳ID: ${j.id}`,
            },
          });

          stats.difficult += 1;
          break;
        }
      }
    } catch (err) {
      logger.error({ err, journalId: j.id }, 'journal AI review error');
      stats.errors += 1;
    }
  }

  return stats;
}
