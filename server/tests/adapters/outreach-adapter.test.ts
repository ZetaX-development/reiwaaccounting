import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailOutreachAdapter } from '../../src/adapters/outreach-adapter.js';

describe('EmailOutreachAdapter', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.OUTREACH_EMAIL_FROM;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('sends via Resend when RESEND_API_KEY is set', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'onboarding@resend.dev';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'abc-123' }), { status: 200 }));

    const result = await new EmailOutreachAdapter().send(
      'kkouta2017@gmail.com',
      '確認のお願い',
      'この証憑のシーンを教えてください',
    );

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    const payload = JSON.parse(init.body as string);
    expect(payload.from).toBe('onboarding@resend.dev');
    expect(payload.to).toEqual(['kkouta2017@gmail.com']);
    expect(payload.subject).toBe('確認のお願い');
    expect(payload.text).toBe('この証憑のシーンを教えてください');
  });

  it('includes attachments in the Resend payload when provided', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));

    await new EmailOutreachAdapter().send('kkouta2017@gmail.com', 's', 'b', [
      { filename: 'receipt.jpg', content: 'AAEC', contentType: 'image/jpeg' },
    ]);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    expect(payload.attachments).toEqual([{ filename: 'receipt.jpg', content: 'AAEC' }]);
  });

  it('returns error with resend status when Resend responds >= 300', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"forbidden"}', { status: 403 }),
    );

    const result = await new EmailOutreachAdapter().send('x@example.com', 's', 'b');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('resend 403');
  });

  it('falls back to SendGrid when RESEND_API_KEY is absent', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    process.env.OUTREACH_EMAIL_FROM = 'bookmee@example.com';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 202 }));

    const result = await new EmailOutreachAdapter().send('x@example.com', 's', 'b');

    expect(result.ok).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.sendgrid.com/v3/mail/send');
  });
});
