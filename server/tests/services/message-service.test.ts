import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { createMessage, listThreads } from '../../src/services/message-service.js';
import { formatForChannel } from '../../src/adapters/notification.js';

beforeAll(async () => {
  // Make sure no leftover threads pollute counts
  await prisma.thread.deleteMany({ where: { clientId: 'aoyama-design' } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('formatForChannel', () => {
  it('produces email plain body', () => {
    expect(formatForChannel('hello\nworld', 'email')).toBe('hello\nworld');
  });
  it('bullets slack body', () => {
    const out = formatForChannel('a\nb\nc', 'slack');
    expect(out.startsWith('@channel')).toBe(true);
    expect(out).toContain('• a');
  });
  it('chatwork prefixes [To:userid]', () => {
    expect(formatForChannel('msg', 'chatwork')).toContain('[To:userid]');
  });
});

describe('createMessage / listThreads', () => {
  it('creates a queued/failed thread when adapter is not configured (no env)', async () => {
    // SENDGRID_API_KEY is unset in test env, so send should fail with NOT_CONFIGURED.
    // The thread should still exist and end up in `failed` status.
    const t = await createMessage({
      clientId: 'aoyama-design',
      channel: 'email',
      subject: '5月月次のご確認',
      body: 'テスト送信',
    });
    expect(t).toBeDefined();
    // Either the immediate send attempt failed (status: 'failed') or the thread
    // is still 'queued' if scheduled. We send immediately so expect 'failed'.
    expect(['failed', 'queued']).toContain(t.status);
    expect(t.errorMsg).toMatch(/未設定|configured/i);

    const threads = await listThreads('aoyama-design');
    expect(threads.length).toBeGreaterThan(0);
    expect(threads[0].body).toBe('テスト送信');
  });

  it('returns 404-like error for unknown client', async () => {
    await expect(
      createMessage({ clientId: 'does-not-exist', channel: 'email', body: 'x' }),
    ).rejects.toThrow(/client not found/);
  });
});
