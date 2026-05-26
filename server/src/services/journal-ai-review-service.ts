/**
 * Spec 21: MF仕訳AIレビューサービス
 *
 * 摘要(memo)が空のMF仕訳をAIで自動補完する。
 * 信頼度 >= 0.8 → MFに自動PUT + status=auto_applied
 * 信頼度 < 0.8  → status=pending でレビューキューに積む
 * localOnly=true の場合はMFへ反映せず、全件 status=auto_applied で完了扱いにする
 */

import OpenAI from 'openai';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { mfApiAdapter } from '../adapters/mf-api.js';
import { updateJournalMemo } from '../adapters/mf-api.js';

const AUTO_APPLY_THRESHOLD = 0.8;

interface MfJournalRaw {
  id: string;
  transaction_date: string;
  memo?: string;
  branches?: {
    debitor?: { account_name?: string; value?: number };
    creditor?: { account_name?: string; value?: number };
  }[];
}

interface AiSuggestion {
  memo: string;
  confidence: number; // 0-1
}

// ---------------------------------------------------------------------------
// AI摘要生成
// ---------------------------------------------------------------------------

async function suggestMemo(
  debit: string,
  credit: string,
  amount: number,
  date: string,
): Promise<AiSuggestion> {
  if (!env.OPENAI_API_KEY) {
    return { memo: `${debit}/${credit}`, confidence: 0.5 };
  }
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const prompt = `以下の仕訳の摘要（memo）を日本語で簡潔に1行で提案してください。
また、提案の確信度を0から1の数値で返してください。

- 日付: ${date}
- 借方科目: ${debit}
- 貸方科目: ${credit}
- 金額: ¥${amount.toLocaleString('ja-JP')}

JSONで返してください: {"memo": "...", "confidence": 0.0}`;

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 100,
    });
    const raw = res.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { memo?: string; confidence?: number };
    return {
      memo: parsed.memo ?? `${debit}→${credit}`,
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
    };
  } catch (err) {
    logger.warn({ err }, 'journal AI suggestion failed');
    return { memo: `${debit}/${credit}`, confidence: 0.3 };
  }
}

// ---------------------------------------------------------------------------
// メイン処理: 未処理仕訳を取得してAI処理
// ---------------------------------------------------------------------------

export interface ProcessResult {
  total: number;
  autoApplied: number;
  pending: number;
  errors: number;
}

export async function processBlankMemoJournals(
  clientId: string,
  firmId: string,
  options?: { localOnly?: boolean },
): Promise<ProcessResult> {
  const localOnly = options?.localOnly === true;

  // 1. クライアント情報取得
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { mfExternalId: true, mfAccessToken: true },
  });
  if (!client?.mfAccessToken) {
    throw new Error('MF連携がされていません');
  }

  // 2. MFから直近90日の仕訳を取得
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await mfApiAdapter.fetchEntries(client.mfExternalId ?? `mock-${clientId}`, since);
  // rawエントリからMF Journal IDと元データを取り出す
  const rawJournals: MfJournalRaw[] = result.items
    .map((e) => e.raw as MfJournalRaw)
    .filter((j, i, arr) => arr.findIndex((x) => x.id === j.id) === i); // dedupe by journal id

  // 3. 摘要が空のものだけ対象
  const blanks = rawJournals.filter((j) => !j.memo?.trim());

  // 4. 既処理済みのIDを取得して除外
  const existing = await prisma.journalAiReview.findMany({
    where: { clientId },
    select: { mfJournalId: true },
  });
  const processedIds = new Set(existing.map((r) => r.mfJournalId));
  const targets = blanks.filter((j) => !processedIds.has(j.id));

  const stats: ProcessResult = { total: targets.length, autoApplied: 0, pending: 0, errors: 0 };

  for (const j of targets) {
    const branch = j.branches?.[0];
    const debit = branch?.debitor?.account_name ?? '不明';
    const credit = branch?.creditor?.account_name ?? '不明';
    const amount = branch?.debitor?.value ?? 0;

    try {
      const suggestion = await suggestMemo(debit, credit, amount, j.transaction_date);

      if (suggestion.confidence >= AUTO_APPLY_THRESHOLD) {
        let status: 'auto_applied' | 'pending' = 'auto_applied';
        let errorMsg: string | null = null;

        if (!localOnly) {
          // 通常モードはMFに自動PUT
          const externalId = client.mfExternalId ?? `mock-${clientId}`;
          const putResult = await updateJournalMemo(externalId, j.id, suggestion.memo);
          status = putResult.ok ? 'auto_applied' : 'pending';
          errorMsg = putResult.ok ? null : (putResult.error ?? 'MF_PUT_FAILED');
        }

        await prisma.journalAiReview.create({
          data: {
            firmId,
            clientId,
            mfJournalId: j.id,
            status,
            aiMemo: suggestion.memo,
            aiConfidence: suggestion.confidence,
            debitAccount: debit,
            creditAccount: credit,
            amount,
            transactionDate: j.transaction_date,
            originalMemo: '',
            errorMsg,
          },
        });

        if (status === 'auto_applied') stats.autoApplied++;
        else stats.pending++;
      } else {
        // レビューキューに積む
        const status = localOnly ? 'auto_applied' : 'pending';
        await prisma.journalAiReview.create({
          data: {
            firmId,
            clientId,
            mfJournalId: j.id,
            status,
            aiMemo: suggestion.memo,
            aiConfidence: suggestion.confidence,
            debitAccount: debit,
            creditAccount: credit,
            amount,
            transactionDate: j.transaction_date,
            originalMemo: '',
          },
        });
        if (status === 'auto_applied') stats.autoApplied++;
        else stats.pending++;
      }
    } catch (err) {
      logger.error({ err, journalId: j.id }, 'journal AI review error');
      stats.errors++;
    }
  }

  return stats;
}
