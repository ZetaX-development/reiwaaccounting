import crypto from 'node:crypto';
import { request } from 'undici';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

const API_BASE = 'https://api.line.me';
const API_DATA_BASE = 'https://api-data.line.me';

export interface BotInfo {
  userId: string;
  basicId: string;
  displayName: string;
  pictureUrl?: string;
  chatMode: string;
  markAsReadMode: string;
}

export interface LineProfile {
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
}

export interface QuickReplyItem {
  type: 'action';
  action: {
    type: 'postback' | 'message';
    label: string;
    data?: string;
    text?: string;
    displayText?: string;
  };
}

// LINE messages payload type (simplified — we only ever build text + optional quickReply).
export interface LineTextMessage {
  type: 'text';
  text: string;
  quickReply?: { items: QuickReplyItem[] };
}

export interface LineFlexMessage {
  type: 'flex';
  altText: string;
  contents: unknown;
  quickReply?: { items: QuickReplyItem[] };
}

export type LineMessage = LineTextMessage | LineFlexMessage;

export class LineApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`LINE API ${status}: ${bodyText.slice(0, 200)}`);
    this.name = 'LineApiError';
  }
}

/**
 * Verify the X-Line-Signature header on a webhook payload.
 *
 * Uses HMAC-SHA256(channelSecret, rawBody), base64-encoded, compared in
 * constant time.
 */
export function verifySignature(
  channelSecret: string,
  rawBody: Buffer,
  signature: string | undefined | null,
): boolean {
  if (!channelSecret || !signature) return false;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  const expected = crypto
    .createHmac('sha256', channelSecret)
    .update(rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  let b: Buffer;
  try {
    b = Buffer.from(signature);
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function authHeaders(): Record<string, string> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new LineApiError(0, 'LINE_CHANNEL_ACCESS_TOKEN not configured');
  }
  return {
    authorization: `Bearer ${token}`,
  };
}

export async function getBotInfo(): Promise<BotInfo> {
  const res = await request(`${API_BASE}/v2/bot/info`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (res.statusCode >= 300) {
    const text = await res.body.text();
    throw new LineApiError(res.statusCode, text);
  }
  return (await res.body.json()) as BotInfo;
}

export async function getProfile(userId: string): Promise<LineProfile> {
  const res = await request(
    `${API_BASE}/v2/bot/profile/${encodeURIComponent(userId)}`,
    { method: 'GET', headers: authHeaders() },
  );
  if (res.statusCode >= 300) {
    const text = await res.body.text();
    throw new LineApiError(res.statusCode, text);
  }
  return (await res.body.json()) as LineProfile;
}

export async function getMessageContent(
  messageId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await request(
    `${API_DATA_BASE}/v2/bot/message/${encodeURIComponent(messageId)}/content`,
    { method: 'GET', headers: authHeaders() },
  );
  if (res.statusCode >= 300) {
    const text = await res.body.text();
    throw new LineApiError(res.statusCode, text);
  }
  const mimeType =
    (typeof res.headers['content-type'] === 'string'
      ? res.headers['content-type']
      : Array.isArray(res.headers['content-type'])
        ? res.headers['content-type'][0]
        : 'application/octet-stream') || 'application/octet-stream';
  const arrayBuffer = await res.body.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: mimeType.split(';')[0].trim(),
  };
}

export async function replyMessage(
  replyToken: string,
  messages: LineMessage[],
): Promise<void> {
  try {
    const res = await request(`${API_BASE}/v2/bot/message/reply`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ replyToken, messages }),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      logger.warn({ status: res.statusCode, body: text }, 'line replyMessage failed');
    } else {
      // drain body so undici doesn't warn
      await res.body.text();
    }
  } catch (err) {
    logger.warn({ err }, 'line replyMessage threw');
  }
}

export async function pushMessage(
  userId: string,
  messages: LineMessage[],
): Promise<void> {
  try {
    const res = await request(`${API_BASE}/v2/bot/message/push`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      logger.warn({ status: res.statusCode, body: text }, 'line pushMessage failed');
    } else {
      await res.body.text();
    }
  } catch (err) {
    logger.warn({ err }, 'line pushMessage threw');
  }
}

export async function pushQuickReply(
  userId: string,
  text: string,
  items: QuickReplyItem[],
): Promise<void> {
  const msg: LineTextMessage = {
    type: 'text',
    text,
    quickReply: { items },
  };
  await pushMessage(userId, [msg]);
}

export async function pushFlexMessage(
  userId: string,
  altText: string,
  contents: unknown,
): Promise<void> {
  const msg: LineFlexMessage = {
    type: 'flex',
    altText,
    contents,
  };
  await pushMessage(userId, [msg]);
}
