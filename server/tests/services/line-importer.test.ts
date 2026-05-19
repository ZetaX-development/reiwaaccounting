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
  type LineWebhookEvent,
} from '../../src/services/line-importer.js';
import * as lineService from '../../src/services/line-service.js';
import * as voucherService from '../../src/services/voucher-service.js';

beforeEach(async () => {
  __clearCaptionCacheForTests();
  await prisma.voucher.deleteMany();
  await prisma.lineUserMapping.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
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
      where: { lineUserId: 'Uaaa' },
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
      where: { lineUserId: 'Ubbb' },
    });
    expect(mapping?.enabled).toBe(false);
  });
});

describe('handleWebhookEvents — message.image from enabled user', () => {
  it('creates a Voucher with source=line and kicks runOcrForVoucher', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'Uccc', displayName: 'C', enabled: true },
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
      data: { lineUserId: 'Uddd', displayName: 'D', enabled: true },
    });
    // pre-existing Voucher from this LINE message
    await prisma.voucher.create({
      data: {
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
  it('auto-creates a disabled mapping and replies 承認待ち without creating Voucher', async () => {
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
      where: { lineUserId: 'Ueee' },
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
      data: { lineUserId: 'Ufff', displayName: 'F', enabled: true },
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
      data: { lineUserId: 'Uggg', displayName: 'G', enabled: true },
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
