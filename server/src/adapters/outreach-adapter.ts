export interface OutreachAdapter {
  readonly channel: 'email' | 'line' | 'mock';
  send(
    target: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }>;
}

export class MockOutreachAdapter implements OutreachAdapter {
  readonly channel = 'mock' as const;
  async send(
    target: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // eslint-disable-next-line no-console
    console.log(`[outreach:mock] to=${target} subject=${subject}\n${body}`);
    return { ok: true };
  }
}

// Send a real email. Gmail (nodemailer) is tried first if GMAIL_USER +
// GMAIL_APP_PASSWORD are set; otherwise falls back to SendGrid v3.
// OUTREACH_EMAIL_FROM overrides the FROM address for both transports.
export class EmailOutreachAdapter implements OutreachAdapter {
  readonly channel = 'email' as const;
  async send(
    target: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const from = process.env.OUTREACH_EMAIL_FROM || gmailUser || process.env.EMAIL_FROM;

    // --- Gmail (nodemailer) path ---
    if (gmailUser && gmailPass) {
      try {
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: gmailUser, pass: gmailPass },
        });
        await transporter.sendMail({ from: from ?? gmailUser, to: target, subject, text: body });
        return { ok: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `gmail send failed: ${msg}` };
      }
    }

    // --- SendGrid fallback ---
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      return { ok: false, error: 'GMAIL_USER/GMAIL_APP_PASSWORD or SENDGRID_API_KEY is not set' };
    }
    if (!from) {
      return { ok: false, error: 'OUTREACH_EMAIL_FROM is not set' };
    }
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: target }] }],
          from: { email: from },
          subject,
          content: [{ type: 'text/plain', value: body }],
        }),
      });
      if (res.status >= 300) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          error: `sendgrid ${res.status}: ${errText.slice(0, 200)}`,
        };
      }
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `sendgrid request failed: ${msg}` };
    }
  }
}

// Push a text message to a LINE userId via the Messaging API. Requires
// LINE_CHANNEL_ACCESS_TOKEN in env (Spec 16 setup). The target should be a
// LINE userId (the `U…` string) — not an email or display name.
export class LineOutreachAdapter implements OutreachAdapter {
  readonly channel = 'line' as const;
  async send(
    target: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) {
      return { ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN is not set' };
    }
    if (!target || !target.startsWith('U')) {
      return {
        ok: false,
        error: `invalid LINE userId: ${target || '(empty)'} (expected to start with "U")`,
      };
    }
    const text = subject ? `【${subject}】\n${body}` : body;
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: target,
          messages: [{ type: 'text', text }],
        }),
      });
      if (res.status >= 300) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          error: `line ${res.status}: ${errText.slice(0, 200)}`,
        };
      }
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `line push failed: ${msg}` };
    }
  }
}

// Send a message to a ChatWork room via ChatWork API v1.
// Requires CHATWORK_API_TOKEN in env and the target to be a room ID (numeric string).
export class ChatWorkOutreachAdapter implements OutreachAdapter {
  readonly channel = 'mock' as const; // reuse 'mock' type slot for now
  async send(
    target: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const token = process.env.CHATWORK_API_TOKEN;
    if (!token) {
      return { ok: false, error: 'CHATWORK_API_TOKEN is not set' };
    }
    const roomId = target.replace(/\D/g, '');
    if (!roomId) {
      return { ok: false, error: `invalid ChatWork room ID: ${target}` };
    }
    const message = subject ? `[info][title]${subject}[/title]${body}[/info]` : body;
    try {
      const res = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
        method: 'POST',
        headers: {
          'X-ChatWorkToken': token,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `body=${encodeURIComponent(message)}`,
      });
      if (res.status >= 300) {
        const errText = await res.text().catch(() => '');
        return { ok: false, error: `chatwork ${res.status}: ${errText.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `chatwork request failed: ${msg}` };
    }
  }
}

export function getOutreachAdapter(
  channel: 'mock' | 'email' | 'line' | 'chatwork',
): OutreachAdapter {
  switch (channel) {
    case 'email':
      return new EmailOutreachAdapter();
    case 'line':
      return new LineOutreachAdapter();
    case 'chatwork':
      return new ChatWorkOutreachAdapter();
    case 'mock':
    default:
      return new MockOutreachAdapter();
  }
}
