import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { generateDraftJournal } from './journal-draft-service.js';

/** spec 29: メール返信を取り込む際の回答キー（lineAnswers をチャネル非依存の回答マップとして再利用） */
const EMAIL_REPLY_KEY = 'メール返信';

/**
 * spec 29: 顧客からのメール返信本文を Voucher に取り込み、その内容を踏まえて仕訳ドラフトを作り直す。
 * 本物のメール受信は作らず、疑似受信エンドポイント/UI から本文を渡す前提（非ゴール参照）。
 *
 * TODO: lineAnswers はチャネル非依存の回答マップとして再利用している。将来 answers へリネーム。
 */
export async function applyVoucherReply(voucherId: string, text: string): Promise<boolean> {
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { id: true, lineAnswers: true },
  });
  if (!voucher) return false;

  const existing = (voucher.lineAnswers ?? {}) as Record<string, string>;
  await prisma.voucher.update({
    where: { id: voucherId },
    data: { lineAnswers: { ...existing, [EMAIL_REPLY_KEY]: text } },
  });

  // 返信を「追加情報」として再ドラフト。OpenAI 呼び出しで数十秒かかるため、
  // リクエストはブロックせず LINE 経路と同様にバックグラウンドで実行する
  // （同期 await だと応答が ~60s 固まり、UI で連打される原因になっていた）。
  setImmediate(() => {
    void generateDraftJournal(voucherId).catch((err) => {
      logger.warn({ err, voucherId }, 'email reply re-draft failed');
    });
  });
  return true;
}
