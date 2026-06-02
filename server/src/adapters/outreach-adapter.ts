export interface OutreachAttachment {
  filename: string;
  /** base64 エンコード済みのファイル内容 */
  content: string;
  contentType: string;
}

export interface OutreachAdapter {
  readonly channel: 'email' | 'line' | 'mock';
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

// Send a real email. Prefers Resend (https://api.resend.com/emails) when
// RESEND_API_KEY is set, otherwise falls back to SendGrid v3. If neither is
// configured, returns a "not configured" error so the caller can fall back to
// the mock adapter or surface the issue to the user.
export class EmailOutreachAdapter implements OutreachAdapter {
  readonly channel = 'email' as const;
  async send(
    target: string,
    subject: string,
    body: string,
    attachments?: OutreachAttachment[],
  ): Promise<{ ok: boolean; error?: string }> {
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      const from =
        process.env.RESEND_FROM || process.env.OUTREACH_EMAIL_FROM || 'onboarding@resend.dev';
      try {
        const payload: Record<string, unknown> = { from, to: [target], subject, text: body };
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
    const from = process.env.OUTREACH_EMAIL_FROM || process.env.EMAIL_FROM;
    if (!apiKey) {
      return { ok: false, error: 'SENDGRID_API_KEY is not set' };
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
// LINE userId (the `U…` string) — not an email or display name.
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

export function getOutreachAdapter(
  channel: 'mock' | 'email' | 'line',
): OutreachAdapter {
  switch (channel) {
    case 'email':
      return new EmailOutreachAdapter();
    case 'line':
      return new LineOutreachAdapter();
    case 'mock':
    default:
      return new MockOutreachAdapter();
  }
}
