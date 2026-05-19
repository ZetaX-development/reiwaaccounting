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

export class EmailOutreachAdapter implements OutreachAdapter {
  readonly channel = 'email' as const;
  async send(
    _target: string,
    _subject: string,
    _body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return {
      ok: false,
      error: 'email adapter not configured (TODO: integrate SendGrid)',
    };
  }
}

export class LineOutreachAdapter implements OutreachAdapter {
  readonly channel = 'line' as const;
  async send(
    _target: string,
    _subject: string,
    _body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return {
      ok: false,
      error: 'line adapter not configured (TODO: integrate LINEWORKS)',
    };
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
