import { request } from 'undici';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

export type Channel = 'email' | 'slack' | 'chatwork' | 'line_works' | 'messenger';

export interface SendPayload {
  subject?: string;
  body: string;
  raw?: unknown;
}

export interface SendResult {
  externalId?: string;
}

export class NotificationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface NotificationAdapter {
  readonly channel: Channel;
  send(endpoint: string, payload: SendPayload): Promise<SendResult>;
}

// --- Email (SendGrid) -------------------------------------------------

export const emailAdapter: NotificationAdapter = {
  channel: 'email',
  async send(endpoint, payload) {
    if (!env.SENDGRID_API_KEY || !env.EMAIL_FROM) {
      throw new NotificationError('NOT_CONFIGURED', 'SENDGRID_API_KEY / EMAIL_FROM 未設定');
    }
    const res = await request('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: endpoint.split(',').map((e) => ({ email: e.trim() })) }],
        from: { email: env.EMAIL_FROM },
        subject: payload.subject ?? '(no subject)',
        content: [{ type: 'text/plain', value: payload.body }],
      }),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new NotificationError('SENDGRID_FAILED', `${res.statusCode}: ${text.slice(0, 200)}`);
    }
    const messageId = res.headers['x-message-id'];
    return { externalId: typeof messageId === 'string' ? messageId : undefined };
  },
};

// --- Slack ------------------------------------------------------------

export const slackAdapter: NotificationAdapter = {
  channel: 'slack',
  async send(endpoint, payload) {
    if (!env.SLACK_BOT_TOKEN) {
      throw new NotificationError('NOT_CONFIGURED', 'SLACK_BOT_TOKEN 未設定');
    }
    const res = await request('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: endpoint, text: payload.body }),
    });
    const json = (await res.body.json()) as { ok: boolean; ts?: string; error?: string };
    if (!json.ok) {
      throw new NotificationError('SLACK_FAILED', json.error ?? 'unknown');
    }
    return { externalId: json.ts };
  },
};

// --- Chatwork ---------------------------------------------------------

export const chatworkAdapter: NotificationAdapter = {
  channel: 'chatwork',
  async send(endpoint, payload) {
    if (!env.CHATWORK_API_TOKEN) {
      throw new NotificationError('NOT_CONFIGURED', 'CHATWORK_API_TOKEN 未設定');
    }
    const body = new URLSearchParams({ body: payload.body });
    const res = await request(
      `https://api.chatwork.com/v2/rooms/${encodeURIComponent(endpoint)}/messages`,
      {
        method: 'POST',
        headers: {
          'X-ChatWorkToken': env.CHATWORK_API_TOKEN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
    );
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new NotificationError('CHATWORK_FAILED', `${res.statusCode}: ${text.slice(0, 200)}`);
    }
    const json = (await res.body.json()) as { message_id?: string };
    return { externalId: json.message_id };
  },
};

// --- LINE WORKS -------------------------------------------------------

let cachedLineWorksToken: { token: string; expiresAt: number } | null = null;

async function getLineWorksToken(): Promise<string> {
  if (cachedLineWorksToken && cachedLineWorksToken.expiresAt > Date.now() + 60_000) {
    return cachedLineWorksToken.token;
  }
  if (
    !env.LINEWORKS_CLIENT_ID ||
    !env.LINEWORKS_CLIENT_SECRET ||
    !env.LINEWORKS_SERVICE_ACCOUNT ||
    !env.LINEWORKS_PRIVATE_KEY
  ) {
    throw new NotificationError('NOT_CONFIGURED', 'LINE WORKS 認証情報未設定');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.LINEWORKS_CLIENT_ID,
    sub: env.LINEWORKS_SERVICE_ACCOUNT,
    iat: now,
    exp: now + 3600,
  };
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(env.LINEWORKS_PRIVATE_KEY.replace(/\\n/g, '\n')).toString('base64url');
  const jwt = `${signingInput}.${signature}`;

  const body = new URLSearchParams({
    assertion: jwt,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: env.LINEWORKS_CLIENT_ID,
    client_secret: env.LINEWORKS_CLIENT_SECRET,
    scope: 'bot',
  });
  const res = await request('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new NotificationError(
      'LINEWORKS_AUTH_FAILED',
      `${res.statusCode}: ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.body.json()) as { access_token: string; expires_in?: number };
  cachedLineWorksToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return json.access_token;
}

export const lineWorksAdapter: NotificationAdapter = {
  channel: 'line_works',
  async send(endpoint, payload) {
    if (!env.LINEWORKS_BOT_ID) {
      throw new NotificationError('NOT_CONFIGURED', 'LINEWORKS_BOT_ID 未設定');
    }
    const token = await getLineWorksToken();
    const res = await request(
      `https://www.worksapis.com/v1.0/bots/${env.LINEWORKS_BOT_ID}/channels/${encodeURIComponent(endpoint)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          content: { type: 'text', text: payload.body },
        }),
      },
    );
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new NotificationError(
        'LINEWORKS_SEND_FAILED',
        `${res.statusCode}: ${text.slice(0, 200)}`,
      );
    }
    return {};
  },
};

// --- Messenger (placeholder) -----------------------------------------

export const messengerAdapter: NotificationAdapter = {
  channel: 'messenger',
  async send() {
    throw new NotificationError(
      'NOT_IMPLEMENTED',
      'Messenger チャンネルは未実装 (将来課題)',
    );
  },
};

export function getAdapter(channel: Channel): NotificationAdapter {
  switch (channel) {
    case 'email':
      return emailAdapter;
    case 'slack':
      return slackAdapter;
    case 'chatwork':
      return chatworkAdapter;
    case 'line_works':
      return lineWorksAdapter;
    case 'messenger':
      return messengerAdapter;
    default:
      throw new NotificationError('UNKNOWN_CHANNEL', `unknown channel: ${channel}`);
  }
}

export function formatForChannel(text: string, channel: Channel): string {
  switch (channel) {
    case 'email':
      return text;
    case 'slack': {
      const lines = text.split('\n').filter(Boolean);
      return ['@channel'].concat(lines.map((l) => '• ' + l.trim())).join('\n');
    }
    case 'chatwork':
      return `[To:userid]\n${text}`;
    case 'line_works':
      return text.replace(/\n+/g, ' ').slice(0, 280);
    case 'messenger':
      return text.split('\n')[0] + ' 📩';
    default:
      return text;
  }
}

// Logger silencer suppression: ensure logger is referenced even when adapters
// don't log directly (tree-shaker stays happy; also useful for future hooks).
void logger;
