import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import * as lineImporter from '../../src/services/line-importer.js';
import { __resetEnvCache } from '../../src/env.js';

const TEST_SECRET = 'integration-test-channel-secret';

// Configure env before buildApp() so env.LINE_CHANNEL_SECRET / TOKEN are non-empty.
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
process.env.LINE_CHANNEL_SECRET = TEST_SECRET;
process.env.LINE_CHANNEL_ID = '1234567890';
process.env.LINE_WEBHOOK_BASE_URL = 'https://bookmee.example.com';
__resetEnvCache();

const app = await buildApp();

beforeEach(async () => {
  await prisma.lineUserMapping.deleteMany();
  await prisma.voucher.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.lineUserMapping.deleteMany();
  await prisma.voucher.deleteMany();
  await app.close();
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_SECRET;
  delete process.env.LINE_CHANNEL_ID;
  delete process.env.LINE_WEBHOOK_BASE_URL;
  __resetEnvCache();
});

function sign(body: string): string {
  return crypto.createHmac('sha256', TEST_SECRET).update(body).digest('base64');
}

describe('POST /api/integrations/line/webhook (valid signature)', () => {
  it('returns 200 and schedules handleWebhookEvents', async () => {
    const handlerSpy = vi
      .spyOn(lineImporter, 'handleWebhookEvents')
      .mockResolvedValue(undefined);
    const bodyObj = {
      events: [
        {
          type: 'follow',
          replyToken: 'rt',
          source: { type: 'user', userId: 'Uxyz' },
        },
      ],
    };
    const rawBody = JSON.stringify(bodyObj);
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/webhook',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': sign(rawBody),
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(handlerSpy).toHaveBeenCalledOnce();
    const events = handlerSpy.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('follow');
  });
});

describe('POST /api/integrations/line/webhook (invalid signature)', () => {
  it('returns 401 INVALID_SIGNATURE and does not schedule handler', async () => {
    const handlerSpy = vi
      .spyOn(lineImporter, 'handleWebhookEvents')
      .mockResolvedValue(undefined);
    const rawBody = JSON.stringify({ events: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/webhook',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': 'totally-wrong',
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
    await new Promise((r) => setImmediate(r));
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/integrations/line', () => {
  it('returns connected status with webhookUrl and counts', async () => {
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A', enabled: true },
    });
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U2', displayName: 'B', enabled: false },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/line',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(true);
    expect(body.channelId).toBe('1234567890');
    expect(body.webhookUrl).toBe(
      'https://bookmee.example.com/api/integrations/line/webhook',
    );
    expect(body.userCount).toBe(2);
    expect(body.enabledUserCount).toBe(1);
  });
});

describe('PATCH /api/integrations/line/users/:id', () => {
  it('updates staffLabel and enabled', async () => {
    const mapping = await prisma.lineUserMapping.create({
      data: { lineUserId: 'U3', displayName: 'C', enabled: false },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/integrations/line/users/${mapping.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { staffLabel: '所長', enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.staffLabel).toBe('所長');
    expect(body.enabled).toBe(true);
    const row = await prisma.lineUserMapping.findUnique({
      where: { id: mapping.id },
    });
    expect(row?.staffLabel).toBe('所長');
    expect(row?.enabled).toBe(true);
  });
});

describe('DELETE /api/integrations/line/users/:id', () => {
  it('removes the mapping and returns ok', async () => {
    const mapping = await prisma.lineUserMapping.create({
      data: { lineUserId: 'U4', displayName: 'D', enabled: false },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/line/users/${mapping.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.lineUserMapping.findUnique({
      where: { id: mapping.id },
    });
    expect(row).toBeNull();
  });
});
