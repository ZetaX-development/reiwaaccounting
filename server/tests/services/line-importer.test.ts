import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  handleWebhookEvents,
  __clearCaptionCacheForTests,
  __clearPendingQuestionCacheForTests,
  __primePendingCacheForTests,
  sendLinePushForVoucherStatus,
  type LineWebhookEvent,
} from '../../src/services/line-importer.js';
import * as lineService from '../../src/services/line-service.js';
import * as voucherService from '../../src/services/voucher-service.js';
import * as journalDraftService from '../../src/services/journal-draft-service.js';
import { __resetEnvCache } from '../../src/env.js';

beforeEach(async () => {
  __clearCaptionCacheForTests();
  __clearPendingQuestionCacheForTests();
  await prisma.voucher.deleteMany();
  await prisma.lineUserMapping.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  __resetEnvCache();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.lineUserMapping.deleteMany();
  await prisma.$disconnect();
});

function jpgBuffer(): Buffer {
  // minimal jpeg-shaped buffer (SOI + a couple bytes)
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}

describe('handleWebhookEvents — follow', () => {
  it('upserts LineUserMapping with enabled=false and sends welcome reply', async () => {
    const getProfileSpy = vi
      .spyOn(lineService, 'getProfile')
      .mockResolvedValue({ displayName: '田中太郎' });
    const replySpy = vi
      .spyOn(lineService, 'replyMessage')
      .mockResolvedValue(undefined);

    const event: LineWebhookEvent = {
      type: 'follow',
      replyToken: 'rt-1',
      source: { type: 'user', userId: 'Uaaa' },
    };
    await handleWebhookEvents([event]);

    const mapping = await prisma.lineUserMapping.findUnique({
      where: { firmId_lineUserId: { firmId: 'demo-firm', lineUserId: 'Uaaa' } },
    });
    expect(mapping).not.toBeNull();
    expect(mapping?.enabled).toBe(false);
    expect(mapping?.displayName).toBe('田中太郎');
    expect(getProfileSpy).toHaveBeenCalledWith('Uaaa');
    expect(replySpy).toHaveBeenCalledOnce();
    const [token, messages] = replySpy.mock.calls[0];
    expect(token).toBe('rt-1');
    expect(messages[0].type).toBe('text');
  });
});

describe('handleWebhookEvents — unfollow', () => {
  it('sets enabled=false for an existing mapping', async () => {
    await prisma.lineUserMapping.create({
      data: {
        firmId: 'demo-firm',
        lineUserId: 'Ubbb',
        displayName: 'X',
        enabled: true,
      },
    });
    const event: LineWebhookEvent = {
      type: 'unfollow',
      source: { type: 'user', userId: 'Ubbb' },
    };
    await handleWebhookEvents([event]);
    const mapping = await prisma.lineUserMapping.findUnique({
      where: { firmId_lineUserId: { firmId: 'demo-firm', lineUserId: 'Ubbb' } },
    });
    expect(mapping?.enabled).toBe(false);
  });
});

describe('handleWebhookEvents — message.image from enabled user', () => {
  it('creates a Voucher with source=line and kicks runOcrForVoucher', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    __resetEnvCache();
    await prisma.lineUserMapping.create({
      data: { firmId: 'demo-firm', lineUserId: 'Uccc', displayName: 'C', enabled: true },
    });
    vi.spyOn(lineService, 'getMessageContent').mockResolvedValue({
      buffer: jpgBuffer(),
      mimeType: 'image/jpeg',
    });
    const ocrSpy = vi
      .spyOn(voucherService, 'runOcrForVoucher')
      .mockResolvedValue(undefined);

    const event: LineWebhookEvent = {
      type: 'message',
      replyToken: 'rt-img',
      source: { type: 'user', userId: 'Uccc' },
      message: { id: 'msg-100', type: 'image' },
    };
    await handleWebhookEvents([event]);

    const voucher = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'msg-100' },
    });
    expect(voucher).not.toBeNull();
    expect(voucher?.source).toBe('line');
    expect(voucher?.lineUserId).toBe('Uccc');
    expect(voucher?.uploadedBy).toBe('line');
    expect(voucher?.mimeType).toBe('image/jpeg');

    // OCR kick uses setImmediate — wait one tick
    await new Promise((r) => setImmediate(r));
    expect(ocrSpy).toHaveBeenCalledWith(voucher!.id);
  });
});

describe('handleWebhookEvents — duplicate messageId', () => {
  it('skips when a Voucher already exists for that lineSourceMessageId', async () => {
    await prisma.lineUserMapping.create({
      data: { firmId: 'demo-firm', lineUserId: 'Uddd', displayName: 'D', enabled: true },
    });
    // pre-existing Voucher from this LINE message
    await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: null,
        filename: 'line-msg-200.jpg',
        mimeType: 'image/jpeg',
        size: 4,
        imageData: jpgBuffer(),
        source: 'line',
        lineSourceMessageId: 'msg-200',
        lineUserId: 'Uddd',
      },
    });
    const contentSpy = vi
      .spyOn(lineService, 'getMessageContent')
      .mockResolvedValue({ buffer: jpgBuffer(), mimeType: 'image/jpeg' });

    const event: LineWebhookEvent = {
      type: 'message',
      source: { type: 'user', userId: 'Uddd' },
      message: { id: 'msg-200', type: 'image' },
    };
    await handleWebhookEvents([event]);

    // getMessageContent must NOT have been called (we short-circuited)
    expect(contentSpy).not.toHaveBeenCalled();
    const count = await prisma.voucher.count({
      where: { lineSourceMessageId: 'msg-200' },
    });
    expect(count).toBe(1);
  });
});

describe('handleWebhookEvents — unregistered user sends image', () => {
  it('auto-creates a disabled mapping and replies 承認待ち without creating Voucher (firmId auto-set by service)', async () => {
    const getProfileSpy = vi
      .spyOn(lineService, 'getProfile')
      .mockResolvedValue({ displayName: '不審者' });
    const replySpy = vi
      .spyOn(lineService, 'replyMessage')
      .mockResolvedValue(undefined);
    const contentSpy = vi
      .spyOn(lineService, 'getMessageContent')
      .mockResolvedValue({ buffer: jpgBuffer(), mimeType: 'image/jpeg' });

    const event: LineWebhookEvent = {
      type: 'message',
      replyToken: 'rt-new',
      source: { type: 'user', userId: 'Ueee' },
      message: { id: 'msg-300', type: 'image' },
    };
    await handleWebhookEvents([event]);

    const mapping = await prisma.lineUserMapping.findUnique({
      where: { firmId_lineUserId: { firmId: 'demo-firm', lineUserId: 'Ueee' } },
    });
    expect(mapping).not.toBeNull();
    expect(mapping?.enabled).toBe(false);
    expect(getProfileSpy).toHaveBeenCalledWith('Ueee');
    expect(replySpy).toHaveBeenCalledOnce();
    expect(contentSpy).not.toHaveBeenCalled();

    const voucher = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'msg-300' },
    });
    expect(voucher).toBeNull();
  });
});

describe('handleWebhookEvents — batch text → image caption', () => {
  it('attaches the caption from a same-user text event in the same batch', async () => {
    await prisma.lineUserMapping.create({
      data: { firmId: 'demo-firm', lineUserId: 'Ufff', displayName: 'F', enabled: true },
    });
    vi.spyOn(lineService, 'getMessageContent').mockResolvedValue({
      buffer: jpgBuffer(),
      mimeType: 'image/jpeg',
    });
    vi.spyOn(voucherService, 'runOcrForVoucher').mockResolvedValue(undefined);

    const events: LineWebhookEvent[] = [
      {
        type: 'message',
        source: { type: 'user', userId: 'Ufff' },
        message: { id: 'txt-1', type: 'text', text: '青山デザイン タクシー代' },
      },
      {
        type: 'message',
        source: { type: 'user', userId: 'Ufff' },
        message: { id: 'msg-400', type: 'image' },
      },
    ];
    await handleWebhookEvents(events);

    const voucher = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'msg-400' },
    });
    expect(voucher?.caption).toBe('青山デザイン タクシー代');
  });
});

describe('handleWebhookEvents — batch image → text (text first wins)', () => {
  it('still attaches the caption because text is processed before image', async () => {
    await prisma.lineUserMapping.create({
      data: { firmId: 'demo-firm', lineUserId: 'Uggg', displayName: 'G', enabled: true },
    });
    vi.spyOn(lineService, 'getMessageContent').mockResolvedValue({
      buffer: jpgBuffer(),
      mimeType: 'image/jpeg',
    });
    vi.spyOn(voucherService, 'runOcrForVoucher').mockResolvedValue(undefined);

    const events: LineWebhookEvent[] = [
      {
        type: 'message',
        source: { type: 'user', userId: 'Uggg' },
        message: { id: 'msg-500', type: 'image' },
      },
      {
        type: 'message',
        source: { type: 'user', userId: 'Uggg' },
        message: { id: 'txt-2', type: 'text', text: '橋本商店 5/15' },
      },
    ];
    await handleWebhookEvents(events);

    const voucher = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'msg-500' },
    });
    expect(voucher?.caption).toBe('橋本商店 5/15');
  });
});

describe('handleWebhookEvents — postback action=approve', () => {
  it('updates Voucher.journalStatus to approved', async () => {
    const v = await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: null,
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        imageData: jpgBuffer(),
        source: 'line',
        lineUserId: 'Uhhh',
        journalStatus: 'drafted',
      },
    });
    vi.spyOn(lineService, 'replyMessage').mockResolvedValue(undefined);

    const event: LineWebhookEvent = {
      type: 'postback',
      replyToken: 'rt-pb',
      source: { type: 'user', userId: 'Uhhh' },
      postback: { data: `voucherId=${v.id}&action=approve` },
    };
    await handleWebhookEvents([event]);

    const row = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(row?.journalStatus).toBe('approved');
  });
});

describe('sendLinePushForVoucherStatus — needs_info', () => {
  it('pushes a question and caches it when journalStatus is needs_info', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    __resetEnvCache();

    const v = await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: null,
        filename: 'q.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        imageData: jpgBuffer(),
        source: 'line',
        lineUserId: 'Uiii',
        journalStatus: 'needs_info',
        draftJournalJson: {
          transactionDate: '2026-05-25',
          debit: { account: '接待交際費', subAccount: null, partner: 'テスト', taxClass: '課税仕入10%', invoiceNumber: null, amount: 5000 },
          credit: { account: '現金', subAccount: null, partner: null, taxClass: '対象外', invoiceNumber: null, amount: 5000 },
          description: 'テスト',
          missingFields: ['参加者'],
          reasoning: 'テスト',
        } as never,
      },
    });

    const pushSpy = vi.spyOn(lineService, 'pushMessage').mockResolvedValue(undefined);

    await sendLinePushForVoucherStatus(v.id);

    expect(pushSpy).toHaveBeenCalledOnce();
    const [userId, messages] = pushSpy.mock.calls[0];
    expect(userId).toBe('Uiii');
    expect(messages[0].type).toBe('text');
    expect((messages[0] as { type: string; text: string }).text).toContain('参加者');
  });
});

describe('handleWebhookEvents — text reply answers pending question', () => {
  it('saves lineAnswers and triggers generateDraftJournal', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    __resetEnvCache();

    await prisma.lineUserMapping.create({
      data: { firmId: 'demo-firm', lineUserId: 'Ujjj', displayName: 'J', enabled: true },
    });
    const v = await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: null,
        filename: 'pq.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        imageData: jpgBuffer(),
        source: 'line',
        lineUserId: 'Ujjj',
        journalStatus: 'needs_info',
        draftJournalJson: {
          transactionDate: '2026-05-25',
          debit: { account: '接待交際費', subAccount: null, partner: 'テスト', taxClass: '課税仕入10%', invoiceNumber: null, amount: 5000 },
          credit: { account: '現金', subAccount: null, partner: null, taxClass: '対象外', invoiceNumber: null, amount: 5000 },
          description: 'テスト',
          missingFields: ['参加者'],
          reasoning: 'テスト',
        } as never,
      },
    });

    // Prime the pending cache via sendLinePushForVoucherStatus
    vi.spyOn(lineService, 'pushMessage').mockResolvedValue(undefined);
    await sendLinePushForVoucherStatus(v.id);

    const generateSpy = vi
      .spyOn(journalDraftService, 'generateDraftJournal')
      .mockResolvedValue(undefined);

    const event: LineWebhookEvent = {
      type: 'message',
      source: { type: 'user', userId: 'Ujjj' },
      message: { id: 'txt-ans-1', type: 'text', text: '田中部長と鈴木様' },
    };
    await handleWebhookEvents([event]);

    const row = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(row?.lineAnswers).toMatchObject({ '参加者': '田中部長と鈴木様' });

    await new Promise((r) => setImmediate(r));
    expect(generateSpy).toHaveBeenCalledWith(v.id);
  });
});

describe('handleWebhookEvents — text after pending TTL expires falls back to caption', () => {
  it('treats expired text as caption and does not save lineAnswers', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    __resetEnvCache();

    await prisma.lineUserMapping.create({
      data: { firmId: 'demo-firm', lineUserId: 'Ukkk', displayName: 'K', enabled: true },
    });
    const v = await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: null,
        filename: 'stale.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        imageData: jpgBuffer(),
        source: 'line',
        lineUserId: 'Ukkk',
        journalStatus: 'needs_info',
        draftJournalJson: {
          transactionDate: '2026-05-25',
          debit: { account: '接待交際費', subAccount: null, partner: 'テスト', taxClass: '課税仕入10%', invoiceNumber: null, amount: 5000 },
          credit: { account: '現金', subAccount: null, partner: null, taxClass: '対象外', invoiceNumber: null, amount: 5000 },
          description: 'テスト',
          missingFields: ['参加者'],
          reasoning: 'テスト',
        } as never,
      },
    });

    // Prime with an already-expired timestamp (11 minutes ago)
    __primePendingCacheForTests('Ukkk', v.id, '参加者', Date.now() - 11 * 60 * 1000);

    const generateSpy = vi
      .spyOn(journalDraftService, 'generateDraftJournal')
      .mockResolvedValue(undefined);
    vi.spyOn(lineService, 'getMessageContent').mockResolvedValue({
      buffer: jpgBuffer(),
      mimeType: 'image/jpeg',
    });
    vi.spyOn(voucherService, 'runOcrForVoucher').mockResolvedValue(undefined);

    const textEvent: LineWebhookEvent = {
      type: 'message',
      source: { type: 'user', userId: 'Ukkk' },
      message: { id: 'txt-expired', type: 'text', text: '期限切れ回答' },
    };
    const imgEvent: LineWebhookEvent = {
      type: 'message',
      source: { type: 'user', userId: 'Ukkk' },
      message: { id: 'img-expired', type: 'image' },
    };
    await handleWebhookEvents([textEvent, imgEvent]);

    // lineAnswers on original voucher must be untouched (TTL expired)
    const row = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(row?.lineAnswers).toBeNull();

    // generateDraftJournal must NOT have been called
    expect(generateSpy).not.toHaveBeenCalled();

    // The text should have been used as caption for the new image
    const newVoucher = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'img-expired' },
    });
    expect(newVoucher?.caption).toBe('期限切れ回答');
  });
});
