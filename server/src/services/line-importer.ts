import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import * as lineService from './line-service.js';
import type { QuickReplyItem } from './line-service.js';
import {
  upsertByLineUserId,
  setEnabledByLineUserId,
  getMappingByLineUserId,
} from './line-mapping-service.js';
import { createVoucher, runOcrForVoucher } from './voucher-service.js';
import { generateDraftJournal } from './journal-draft-service.js';
import { writeJournalToMf } from './mf-browser-service.js';

// ---- LINE webhook payload shapes (only the fields we touch) -------------

interface LineSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
}

interface LineMessageBase {
  id: string;
  type: string;
}
interface LineImageMessage extends LineMessageBase {
  type: 'image';
  contentProvider?: { type: string };
}
interface LineTextMessage extends LineMessageBase {
  type: 'text';
  text: string;
}
type LineIncomingMessage = LineImageMessage | LineTextMessage | LineMessageBase;

export interface LineWebhookEvent {
  type: string;
  source?: LineSource;
  replyToken?: string;
  message?: LineIncomingMessage;
  postback?: { data: string };
  timestamp?: number;
}

// ---- caption cache (in-memory, TTL 60s) --------------------------------

interface CachedCaption {
  text: string;
  capturedAt: number;
}
const captionCache = new Map<string, CachedCaption>();
const CAPTION_TTL_MS = 60_000;

// ---- pending question cache (in-memory, TTL 10 min) --------------------

interface PendingQuestion {
  voucherId: string;
  field: string;
  askedAt: number;
}
const pendingQuestionCache = new Map<string, PendingQuestion>();
const PENDING_TTL_MS = 10 * 60 * 1000;

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png']);

const WELCOME_TEXT =
  '事務所スタッフ承認待ちです。所長が承認すると使えるようになります。';
const PENDING_APPROVAL_TEXT =
  '承認待ちです。所長が有効化するまで画像は受け付けられません。';
const FILE_TOO_LARGE_TEXT = '画像サイズが大きすぎます（10MB まで）。';
const UNSUPPORTED_MIME_TEXT =
  '画像形式が非対応です。JPG / PNG で送ってください。';

// ---- entry point -------------------------------------------------------

export async function handleWebhookEvents(
  events: LineWebhookEvent[],
): Promise<void> {
  // Same-batch ordering: process text events first (so the cache is primed),
  // then images, then everything else. Different users are independent so
  // a single sort over the whole batch is sufficient.
  const priority = (e: LineWebhookEvent): number => {
    if (e.type === 'message' && e.message?.type === 'text') return 0;
    if (e.type === 'message' && e.message?.type === 'image') return 1;
    return 2;
  };
  const sorted = [...events].sort((a, b) => priority(a) - priority(b));

  for (const event of sorted) {
    try {
      await handleEvent(event);
    } catch (err) {
      logger.warn({ err, eventType: event.type }, 'line event failed');
    }
  }
}

async function handleEvent(event: LineWebhookEvent): Promise<void> {
  switch (event.type) {
    case 'follow':
      await handleFollow(event);
      return;
    case 'unfollow':
      await handleUnfollow(event);
      return;
    case 'message':
      await handleMessage(event);
      return;
    case 'postback':
      await handlePostback(event);
      return;
    default:
      logger.info({ type: event.type }, 'line event ignored');
      return;
  }
}

// ---- follow / unfollow -------------------------------------------------

async function handleFollow(event: LineWebhookEvent): Promise<void> {
  const userId = event.source?.userId;
  if (!userId) return;
  let displayName = 'unknown';
  try {
    const profile = await lineService.getProfile(userId);
    displayName = profile.displayName ?? 'unknown';
  } catch (err) {
    logger.warn({ err, userId }, 'line getProfile on follow failed');
  }
  await upsertByLineUserId(userId, displayName);
  if (event.replyToken) {
    await lineService.replyMessage(event.replyToken, [
      { type: 'text', text: WELCOME_TEXT },
    ]);
  }
}

async function handleUnfollow(event: LineWebhookEvent): Promise<void> {
  const userId = event.source?.userId;
  if (!userId) return;
  await setEnabledByLineUserId(userId, false);
}

// ---- message dispatch --------------------------------------------------

async function handleMessage(event: LineWebhookEvent): Promise<void> {
  const userId = event.source?.userId;
  const message = event.message;
  if (!userId || !message) return;

  if (message.type === 'text') {
    await handleTextMessage(userId, (message as LineTextMessage).text);
    return;
  }
  if (message.type === 'image') {
    await handleImageMessage(event, userId, message as LineImageMessage);
    return;
  }
  // other message types: ignore
}

async function handleTextMessage(userId: string, text: string): Promise<void> {
  if (!text) return;
  const answered = await answerPendingQuestion(userId, text);
  if (answered) return;
  captionCache.set(userId, { text, capturedAt: Date.now() });
}

async function answerPendingQuestion(userId: string, text: string): Promise<boolean> {
  const pending = pendingQuestionCache.get(userId);
  if (!pending) return false;
  pendingQuestionCache.delete(userId);
  if (Date.now() - pending.askedAt > PENDING_TTL_MS) return false;

  const current = await prisma.voucher.findUnique({
    where: { id: pending.voucherId },
    select: { lineAnswers: true },
  });
  if (!current) return false;

  const existing = (current.lineAnswers ?? {}) as Record<string, string>;
  await prisma.voucher.update({
    where: { id: pending.voucherId },
    data: { lineAnswers: { ...existing, [pending.field]: text } },
  });

  setImmediate(() => {
    void (async () => {
      try {
        await generateDraftJournal(pending.voucherId);
        await sendLinePushForVoucherStatus(pending.voucherId);
      } catch (err) {
        logger.warn({ err }, 'line answer re-draft failed');
      }
    })();
  });
  return true;
}

function consumeCaption(userId: string): string | null {
  const entry = captionCache.get(userId);
  if (!entry) return null;
  captionCache.delete(userId);
  if (Date.now() - entry.capturedAt > CAPTION_TTL_MS) return null;
  return entry.text;
}

async function handleImageMessage(
  event: LineWebhookEvent,
  userId: string,
  message: LineImageMessage,
): Promise<void> {
  // 1. look up mapping, auto-create disabled if missing
  let mapping = await getMappingByLineUserId(userId);
  if (!mapping) {
    let displayName = 'unknown';
    try {
      const profile = await lineService.getProfile(userId);
      displayName = profile.displayName ?? 'unknown';
    } catch (err) {
      logger.warn({ err, userId }, 'line getProfile on image failed');
    }
    mapping = await upsertByLineUserId(userId, displayName);
  }
  if (!mapping.enabled) {
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        { type: 'text', text: PENDING_APPROVAL_TEXT },
      ]);
    }
    return;
  }

  // 2. dedupe via Voucher.lineSourceMessageId (unique)
  const existing = await prisma.voucher.findUnique({
    where: { lineSourceMessageId: message.id },
    select: { id: true },
  });
  if (existing) {
    logger.info({ messageId: message.id }, 'line image already imported');
    return;
  }

  // 3. fetch content (size + mime checks)
  let content: { buffer: Buffer; mimeType: string };
  try {
    content = await lineService.getMessageContent(message.id);
  } catch (err) {
    logger.warn({ err, messageId: message.id }, 'line getMessageContent failed');
    return;
  }
  if (content.buffer.byteLength > MAX_CONTENT_BYTES) {
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        { type: 'text', text: FILE_TOO_LARGE_TEXT },
      ]);
    }
    return;
  }
  if (!ALLOWED_MIMES.has(content.mimeType)) {
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        { type: 'text', text: UNSUPPORTED_MIME_TEXT },
      ]);
    }
    return;
  }

  // 4. caption
  const caption = consumeCaption(userId);

  // 5. createVoucher — always start as unclassified
  const filename = `line-${message.id}.${content.mimeType === 'image/png' ? 'png' : 'jpg'}`;
  const meta = await createVoucher({
    clientId: null,
    filename,
    mimeType: content.mimeType,
    buffer: content.buffer,
    uploadedBy: 'line',
  });

  // 6. backfill LINE source columns
  await prisma.voucher.update({
    where: { id: meta.id },
    data: {
      source: 'line',
      lineSourceMessageId: message.id,
      lineUserId: userId,
      caption,
    },
  });

  // 7. 即時受付確認を返信（OCR完了前に送ることで体感待ち時間を短縮）
  if (event.replyToken) {
    await lineService.replyMessage(event.replyToken, [
      { type: 'text', text: '受け付けました。少々お待ちください...' },
    ]);
  }

  // 8. kick OCR pipeline if configured
  if (env.OPENAI_API_KEY) {
    setImmediate(() => {
      runOcrForVoucher(meta.id).catch(() => {});
    });
  }
}

// ---- postback ----------------------------------------------------------

function parsePostbackData(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of data.split('&')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx === -1) {
      out[decodeURIComponent(part)] = '';
    } else {
      out[decodeURIComponent(part.slice(0, idx))] = decodeURIComponent(
        part.slice(idx + 1),
      );
    }
  }
  return out;
}

const JOURNAL_STATUS_BY_ACTION: Record<string, string> = {
  approve: 'approved',
  rework: 'rework',
  later: 'pending',
};

async function handlePostback(event: LineWebhookEvent): Promise<void> {
  if (!event.postback?.data) return;
  const params = parsePostbackData(event.postback.data);
  const voucherId = params.voucherId;
  const action = params.action;
  if (!voucherId || !action) return;

  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: {
      id: true,
      clientId: true,
      client: {
        select: {
          name: true,
          mfAccessToken: true,
        },
      },
    },
  });
  if (!voucher) {
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        { type: 'text', text: '対象が見つかりません。' },
      ]);
    }
    return;
  }

  if (action === 'client') {
    if (!params.clientId) return;
    await prisma.voucher.update({
      where: { id: voucherId },
      data: { clientId: params.clientId, matchedClientReason: 'manual' },
    });
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        { type: 'text', text: '顧問先を更新しました。' },
      ]);
    }
    // re-run assign+match (lazy import to avoid circular dep at module load)
    setImmediate(() => {
      void (async () => {
        try {
          const { assignAndMatchVoucher } = await import('./voucher-service.js');
          await assignAndMatchVoucher(voucherId);
        } catch (err) {
          logger.warn({ err }, 'line postback re-match failed');
        }
      })();
    });
    return;
  }

  // Spec 20: MoneyForward 自動入力
  if (action === 'mf_write') {
    if (!voucher.clientId) {
      await prisma.voucher.update({
        where: { id: voucherId },
        data: {
          mfWriteStatus: 'failed',
          mfWriteError: 'mf_write_rejected: clientId is null',
          mfWriteAt: new Date(),
        },
      });
      if (event.replyToken) {
        await lineService.replyMessage(event.replyToken, [
          { type: 'text', text: '顧問先が未設定のため入力できません。先に顧問先を選択してください。' },
        ]);
      }
      return;
    }
    if (!voucher.client?.mfAccessToken) {
      await prisma.voucher.update({
        where: { id: voucherId },
        data: {
          mfWriteStatus: 'failed',
          mfWriteError: `mf_write_rejected: mf token missing for clientId=${voucher.clientId}`,
          mfWriteAt: new Date(),
        },
      });
      if (event.replyToken) {
        await lineService.replyMessage(event.replyToken, [
          { type: 'text', text: '顧問先のMoneyForward連携が未完了です。ダッシュボードで再連携してください。' },
        ]);
      }
      return;
    }
    await prisma.voucher.update({
      where: { id: voucherId },
      data: { mfWriteStatus: 'pending' },
    });
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        { type: 'text', text: 'MoneyForwardへの入力を開始します...' },
      ]);
    }
    setImmediate(() => {
      writeJournalToMf(voucherId).catch((err) => {
        logger.warn({ err, voucherId }, 'mf_write setImmediate failed');
      });
    });
    return;
  }

  const newStatus = JOURNAL_STATUS_BY_ACTION[action];
  if (newStatus) {
    await prisma.voucher.update({
      where: { id: voucherId },
      data: { journalStatus: newStatus },
    });
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        { type: 'text', text: '更新しました。' },
      ]);
    }
    return;
  }

  logger.info({ action }, 'line postback unknown action');
}

// ---- Push hook called from voucher-service.assignAndMatchVoucher ------

/**
 * Inspect the current Voucher row and push the appropriate LINE message:
 *  - ocrStatus=failed       → 撮り直し依頼
 *  - journalStatus=drafted  → ✅ OK / 🔄 直す / ❓ あとで quick reply
 */
export async function sendLinePushForVoucherStatus(
  voucherId: string,
): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: {
      id: true,
      source: true,
      lineUserId: true,
      ocrStatus: true,
      matchStatus: true,
      matchedClientReason: true,
      journalStatus: true,
      draftJournalJson: true,
      clientId: true,
      client: {
        select: { mfAccessToken: true },
      },
    },
  });
  if (!v || v.source !== 'line' || !v.lineUserId) return;

  if (v.ocrStatus === 'failed') {
    await lineService.pushMessage(v.lineUserId, [
      {
        type: 'text',
        text: '画像の読み取りに失敗しました。撮り直してください。',
      },
    ]);
    return;
  }

  // 'inquired' = outreach サービスが問い合わせ済み。LINE voucher の場合は
  // 追加情報が不足しているので、'needs_info' と同様に LINE で質問する。
  if (v.journalStatus === 'inquired' || v.journalStatus === 'needs_info') {
    const draft = (v.draftJournalJson ?? {}) as { missingFields?: string[] };
    const field = draft.missingFields?.[0];
    if (!field) return;
    pendingQuestionCache.set(v.lineUserId, { voucherId: v.id, field, askedAt: Date.now() });
    await lineService.pushMessage(v.lineUserId, [
      { type: 'text', text: buildQuestion(field) },
    ]);
    return;
  }

  // spec 30: 自動確定された証憑は LINE に「登録しました」通知のみ（ボタンなし）。
  if (v.journalStatus === 'approved') {
    const draft = (v.draftJournalJson ?? {}) as Record<string, unknown>;
    if (draft.autoClassified === true) {
      const debit = (typeof draft.debit === 'object' && draft.debit !== null ? draft.debit : {}) as Record<string, unknown>;
      const account =
        typeof debit.account === 'string' ? debit.account :
        typeof draft.account === 'string' ? draft.account :
        '（勘定科目）';
      const amount =
        typeof debit.amount === 'number'
          ? `¥${debit.amount.toLocaleString('ja-JP')}`
          : typeof draft.amount === 'number'
            ? `¥${draft.amount.toLocaleString('ja-JP')}`
            : '';
      const text = `✓ ${account} ${amount} で仕訳に登録しました。`.trim();
      await lineService.pushMessage(v.lineUserId, [{ type: 'text', text }]);
    }
    return;
  }

  if (v.journalStatus === 'drafted') {
    const draft = parseDraftJournal(v.draftJournalJson);
    const debit = (typeof draft.debit === 'object' && draft.debit !== null ? draft.debit : {}) as Record<string, unknown>;
    const credit = (typeof draft.credit === 'object' && draft.credit !== null ? draft.credit : {}) as Record<string, unknown>;
    const account =
      typeof debit.account === 'string' ? debit.account :
      typeof draft.account === 'string' ? draft.account : // fallback for old flat format
      '（勘定科目）';
    const creditAccount =
      typeof credit.account === 'string' ? credit.account : '（貸方科目）';
    const amountValue =
      typeof debit.amount === 'number'
        ? debit.amount
        : typeof draft.amount === 'number' // fallback for old flat format
          ? draft.amount
          : null;
    const amountLabel =
      amountValue != null ? `¥${amountValue.toLocaleString('ja-JP')}` : '—';
    const description =
      typeof draft.description === 'string' && draft.description.trim().length > 0
        ? draft.description.trim()
        : '—';
    const transactionDate = formatDateYmd(
      typeof draft.transactionDate === 'string' ? draft.transactionDate : undefined,
    );
    const summaryText = `${account} ${amountLabel} で仕訳を作成しました。`.trim();

    const draftCard = {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#10b981',
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: '✅ 仕訳ドラフト作成',
            color: '#ffffff',
            weight: 'bold',
            size: 'md',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          buildFlexKeyValue('取引日', transactionDate),
          buildFlexKeyValue('金額', amountLabel),
          buildFlexKeyValue('借方', account),
          buildFlexKeyValue('貸方', creditAccount),
          buildFlexKeyValue('摘要', description),
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#10b981',
            height: 'sm',
            action: {
              type: 'postback',
              label: '✅ 承認する',
              data: `voucherId=${voucherId}&action=approve`,
              displayText: '仕訳を承認する',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '✏️ 修正が必要',
              data: `voucherId=${voucherId}&action=rematch`,
              displayText: '修正が必要',
            },
          },
        ],
      },
    };

    // 1. 仕訳サマリ（Flex）
    await lineService.pushFlexMessage(v.lineUserId, summaryText, draftCard);

    // 2. MF入力確認 (Spec 20) — MF連携済みクライアントのみ表示
    const hasMfToken = Boolean(v.client?.mfAccessToken);
    if (hasMfToken) {
      const mfItems: QuickReplyItem[] = [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '✍️ はい',
            data: `voucherId=${voucherId}&action=mf_write`,
            displayText: 'MoneyForwardに入力する',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '⏭️ いいえ',
            data: `voucherId=${voucherId}&action=approve`,
            displayText: 'スキップ',
          },
        },
      ];
      await lineService.pushQuickReply(
        v.lineUserId,
        'MoneyForwardに入力しますか？',
        mfItems,
      );
    } else {
      // MF未連携の場合はダッシュボードで確認できる旨を通知してそのまま承認済みへ
      await prisma.voucher.update({
        where: { id: v.id },
        data: { journalStatus: 'approved' },
      });
      await lineService.pushMessage(v.lineUserId, [
        { type: 'text', text: 'ダッシュボードで仕訳を確認できます。（MoneyForward未連携のため自動入力はスキップ）' },
      ]);
    }
    return;
  }

  if (
    v.matchedClientReason === 'ambiguous' ||
    v.matchedClientReason === 'no_client' ||
    v.matchedClientReason === 'ai_uncertain'
  ) {
    return;
  }
}

function buildQuestion(field: string): string {
  return `仕訳の確認のため教えてください：${field}`;
}

function parseDraftJournal(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return {};
}

function formatDateYmd(value: string | undefined): string {
  const now = new Date();
  const fallback = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed.replace(/-/g, '/');
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(trimmed)) return trimmed;
  const dt = new Date(trimmed);
  if (Number.isNaN(dt.getTime())) return fallback;
  return `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
}

function buildFlexKeyValue(label: string, value: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      {
        type: 'text',
        text: `${label}:`,
        color: '#6b7280',
        size: 'sm',
        flex: 3,
      },
      {
        type: 'text',
        text: value,
        color: '#111827',
        size: 'sm',
        wrap: true,
        flex: 7,
      },
    ],
  };
}

// ---- test helpers ------------------------------------------------------

export function __clearCaptionCacheForTests(): void {
  captionCache.clear();
}

export function __clearPendingQuestionCacheForTests(): void {
  pendingQuestionCache.clear();
}

export function __primePendingCacheForTests(
  userId: string,
  voucherId: string,
  field: string,
  askedAt: number = Date.now(),
): void {
  pendingQuestionCache.set(userId, { voucherId, field, askedAt });
}
