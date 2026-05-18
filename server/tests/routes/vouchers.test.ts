import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import FormData from 'form-data';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';

const app = await buildApp();

beforeEach(async () => {
  await prisma.voucher.deleteMany();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await app.close();
});

function buildForm(opts: {
  file: Buffer;
  filename: string;
  contentType: string;
  clientId?: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const form = new FormData();
  form.append('file', opts.file, {
    filename: opts.filename,
    contentType: opts.contentType,
  });
  if (opts.clientId) form.append('clientId', opts.clientId);
  return {
    payload: form.getBuffer(),
    headers: form.getHeaders() as Record<string, string>,
  };
}

describe('POST /api/vouchers', () => {
  it('accepts a JPEG image and returns 201 with metadata', async () => {
    const { payload, headers } = buildForm({
      file: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      filename: 'IMG_0421.jpg',
      contentType: 'image/jpeg',
      clientId: 'aoyama-design',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/vouchers',
      payload,
      headers: { ...headers, 'x-uploaded-by': 'スタッフ' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.clientId).toBe('aoyama-design');
    expect(body.filename).toBe('IMG_0421.jpg');
    expect(body.mimeType).toBe('image/jpeg');
    expect(body.uploadedBy).toBe('スタッフ');
    expect(body.ocrStatus).toBe('pending');
  });

  it('rejects HEIC with 400 INVALID_MIME', async () => {
    const { payload, headers } = buildForm({
      file: Buffer.from([0x00, 0x00, 0x00, 0x20]),
      filename: 'IMG.heic',
      contentType: 'image/heic',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/vouchers',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_MIME');
  });

  it('rejects oversize file with 400 FILE_TOO_LARGE', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024);
    const { payload, headers } = buildForm({
      file: big,
      filename: 'big.jpg',
      contentType: 'image/jpeg',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/vouchers',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects request with no file field as 400 INVALID_BODY', async () => {
    const form = new FormData();
    // no 'file' field appended — only a non-file field
    form.append('clientId', 'aoyama-design');
    const res = await app.inject({
      method: 'POST',
      url: '/api/vouchers',
      payload: form.getBuffer(),
      headers: form.getHeaders() as Record<string, string>,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_BODY');
  });
});
