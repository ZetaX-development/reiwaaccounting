export interface OutreachAttachment {
  filename: string;
  /** base64 エンコード済みのファイル内容 */
  content: string;
  contentType: string;
}

export interface OutreachAdapter {
  readonly channel: 'email' | 'line' | 'mock' | 'chatwork';
  send(
    target: string,
    subject: string,
    body: string,
    attachments?: OutreachAttachment[],
  ): Promise<{ ok: boolean; error?: string }>;
}

export class MockOutreachAdapter implements OutreachAdapter {
  readonly channel = 'mock' as const;
  async send(
    target: string,
    subject: string,
    body: string,
    attachments?: OutreachAttachment[],
  ): Promise<{ ok: boolean; error?: string }> {
    const att = attachments?.length ? ` attachments=${attachments.length}` : '';
    // eslint-disable-next-line no-console
    console.log(`[outreach:mock] to=${target} subject=${subject}${att}\n${body}`);
    return { ok: true };
  }
}

// Send a real email. Gmail (nodemailer) is tried first if GMAIL_USER +
// GMAIL_APP_PASSWORD are set. Otherwise Resend is used when RESEND_API_KEY is
// set, then SendGrid v3 as the final fallback.
export class EmailOutreachAdapter implements OutreachAdapter {
  readonly channel = 'email' as const;
  async send(
    target: string,
    subject: string,
    body: string,
    attachments?: OutreachAttachment[],
  ): Promise<{ ok: boolean; error?: string }> {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const from = process.env.OUTREACH_EMAIL_FROM || gmailUser || process.env.EMAIL_FROM;

    if (gmailUser && gmailPass) {
      try {
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: gmailUser, pass: gmailPass },
        });
        await transporter.sendMail({
          from: from ?? gmailUser,
          to: target,
          subject,
          text: body,
          attachments: attachments?.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.content, 'base64'),
            contentType: a.contentType,
          })),
        });
        return { ok: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `gmail send failed: ${msg}` };
      }
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      const resendFrom =
        process.env.RESEND_FROM || process.env.OUTREACH_EMAIL_FROM || 'onboarding@resend.dev';
      try {
        const payload: Record<string, unknown> = {
          from: resendFrom,
          to: [target],
          subject,
          text: body,
        };
        if (attachments?.length) {
          payload.attachments = attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
          }));
        }
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (res.status >= 300) {
          const errText = await res.text().catch(() => '');
          return { ok: false, error: `resend ${res.status}: ${errText.slice(0, 200)}` };
        }
        return { ok: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `resend request failed: ${msg}` };
      }
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      return { ok: false, error: 'GMAIL_USER/GMAIL_APP_PASSWORD or SENDGRID_API_KEY is not set' };
    }
    if (!from) {
      return { ok: false, error: 'OUTREACH_EMAIL_FROM is not set' };
    }
    try {
      const sgPayload: Record<string, unknown> = {
        personalizations: [{ to: [{ email: target }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/plain', value: body }],
      };
      if (attachments?.length) {
        sgPayload.attachments = attachments.map((a) => ({
          content: a.content,
          filename: a.filename,
          type: a.contentType,
          disposition: 'attachment',
        }));
      }
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(sgPayload),
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
// LINE userId (the `U...` string), not an email or display name.
export class LineOutreachAdapter implements OutreachAdapter {
  readonly channel = 'line' as const;
  async send(
    target: string,
    subject: string,
    body: string,
    _attachments?: OutreachAttachment[],
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
// Requires CHATWORK_API_TOKEN in env and the target to be a room ID.
export class ChatWorkOutreachAdapter implements OutreachAdapter {
  readonly channel = 'chatwork' as const;
  async send(
    target: string,
    subject: string,
    body: string,
    _attachments?: OutreachAttachment[],
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
