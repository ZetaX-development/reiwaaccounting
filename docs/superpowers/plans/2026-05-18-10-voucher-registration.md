# Spec 10: 証憑登録 (アップロード UI + ストレージ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** スタッフが画像をドラッグ&ドロップで一括アップロードできる「証憑登録」ビューを実装し、ファイルを Postgres BYTEA に保管、未分類/顧問先別タブで一覧表示・削除できる状態にする。

**Architecture:** 新規 Prisma `Voucher` モデルに本体を BYTEA で保存。Fastify ルート 4 本 (POST 作成 / GET 一覧 / GET 画像 / DELETE) + 純関数寄りサービス層。フロントは既存 Vanilla JS の `renderVoucherRegister()` で全 DOM 生成、レイアウト A（上ドロップ + 下タブ + 下サムネ 6 列 grid）。

**Tech Stack:** Fastify 4 / @fastify/multipart 8 / Prisma 5 + PostgreSQL 16 (BYTEA) / Vitest + form-data (テスト) / Vanilla JS フロント。

**Spec source:** `docs/superpowers/specs/2026-05-18-10-voucher-registration-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/package.json` | Modify | `@fastify/multipart`, `form-data` (dev) 追加 |
| `server/prisma/schema.prisma` | Modify | `Voucher` モデル + `Client.vouchers` リレーション |
| `server/prisma/migrations/<ts>_add_voucher/` | Create | Prisma が自動生成 |
| `server/src/services/voucher-service.ts` | Create | createVoucher / listVouchers / getVoucherImage / deleteVoucher |
| `server/src/routes/vouchers.ts` | Create | POST / GET 一覧 / GET 画像 / DELETE |
| `server/src/server.ts` | Modify | `@fastify/multipart` を register + `voucherRoutes` を register |
| `server/tests/services/voucher-service.test.ts` | Create | サービス 6 ケース |
| `server/tests/routes/vouchers.test.ts` | Create | ルート 5 ケース |
| `script.js` | Modify | `appState` 拡張、`loadVouchers` / `uploadVouchers` / `deleteVoucherById` / `renderVoucherRegister` / `labels`・`labels.helper` 更新 / 既存の placeholder renderer 差し替え |
| `styles.css` | Modify | `.voucher-dropzone` 等のクラス追加 |

`index.html` は変更なし（既存の `data-view="vouchers-register"` ナビボタンをそのまま使う）。

---

## Task 1: 依存追加 (@fastify/multipart, form-data)

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: パッケージをインストール**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npm install @fastify/multipart@^8.3.0
npm install --save-dev form-data@^4.0.1
```

Expected: package.json に 2 つの dep が追加され、`npm install` がエラーなしで完了する。

- [ ] **Step 2: 確認**

Run: `grep -E "fastify/multipart|form-data" /home/kkouta/poc/bookmee/server/package.json`
Expected: `"@fastify/multipart": "^8.3.0"` と `"form-data": "^4.0.1"` の 2 行が出る。

- [ ] **Step 3: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/package.json server/package-lock.json
git commit -m "chore(spec 10): add @fastify/multipart and form-data deps"
```

---

## Task 2: Voucher Prisma モデル追加 + マイグレーション

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/*_add_voucher/migration.sql` (Prisma 自動生成)

- [ ] **Step 1: schema.prisma に Voucher モデルを追加**

`server/prisma/schema.prisma` の末尾に追加:

```prisma
model Voucher {
  id         String   @id @default(cuid())
  client     Client?  @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId   String?
  filename   String
  mimeType   String
  size       Int
  imageData  Bytes
  uploadedAt DateTime @default(now())
  uploadedBy String?

  ocrJson        Json?
  ocrStatus      String   @default("pending")
  ocrAt          DateTime?
  matchedEntryId String?
  matchStatus    String   @default("unmatched")

  @@index([clientId, uploadedAt])
  @@index([ocrStatus])
}
```

そして `Client` モデル内のリレーション群（`vendorSyncs` 等が並んでいる箇所）に追加:

```prisma
  vouchers          Voucher[]
```

- [ ] **Step 2: マイグレーション生成 + 適用**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npm run prisma:migrate -- --name add-voucher
```

Expected: 新しいマイグレーションディレクトリが作られて適用され、`@prisma/client` が再生成される。

- [ ] **Step 3: テーブルが作られたことを確認**

Run:
```bash
docker compose exec postgres psql -U bookmee -d bookmee -c '\d "Voucher"'
```

Expected: `Voucher` テーブルの列定義一覧が表示される（`imageData` が `bytea`、`ocrStatus` が `text` default 'pending' 等）。

- [ ] **Step 4: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat(spec 10): add Voucher prisma model with OCR/match fields"
```

---

## Task 3: voucher-service.ts createVoucher (TDD)

**Files:**
- Create: `server/src/services/voucher-service.ts`
- Create: `server/tests/services/voucher-service.test.ts`

- [ ] **Step 1: テストファイルを作って createVoucher の失敗テストを書く**

Create `server/tests/services/voucher-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
  deleteVoucher,
} from '../../src/services/voucher-service.js';

beforeEach(async () => {
  await prisma.voucher.deleteMany();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.$disconnect();
});

describe('createVoucher', () => {
  it('persists the image bytes and returns metadata with defaults', async () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const meta = await createVoucher({
      clientId: 'aoyama-design',
      filename: 'IMG_0421.jpg',
      mimeType: 'image/jpeg',
      buffer,
      uploadedBy: 'スタッフ',
    });
    expect(meta.id).toBeTruthy();
    expect(meta.clientId).toBe('aoyama-design');
    expect(meta.filename).toBe('IMG_0421.jpg');
    expect(meta.mimeType).toBe('image/jpeg');
    expect(meta.size).toBe(4);
    expect(meta.uploadedBy).toBe('スタッフ');
    expect(meta.ocrStatus).toBe('pending');
    expect(meta.matchStatus).toBe('unmatched');

    const row = await prisma.voucher.findUnique({ where: { id: meta.id } });
    expect(row?.imageData).toEqual(buffer);
  });

  it('allows clientId null for the unassigned pool', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 'a.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      uploadedBy: null,
    });
    expect(meta.clientId).toBeNull();
    expect(meta.uploadedBy).toBeNull();
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/services/voucher-service.test.ts
```

Expected: モジュール解決エラーで失敗（`Cannot find module ... voucher-service.js`）。

- [ ] **Step 3: voucher-service.ts を実装**

Create `server/src/services/voucher-service.ts`:

```ts
import { prisma } from '../lib/prisma.js';

export interface VoucherMeta {
  id: string;
  clientId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  uploadedBy: string | null;
  ocrStatus: string;
  matchStatus: string;
}

function toMeta(row: {
  id: string;
  clientId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  uploadedBy: string | null;
  ocrStatus: string;
  matchStatus: string;
}): VoucherMeta {
  return {
    id: row.id,
    clientId: row.clientId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    uploadedAt: row.uploadedAt,
    uploadedBy: row.uploadedBy,
    ocrStatus: row.ocrStatus,
    matchStatus: row.matchStatus,
  };
}

export async function createVoucher(input: {
  clientId: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy: string | null;
}): Promise<VoucherMeta> {
  const row = await prisma.voucher.create({
    data: {
      clientId: input.clientId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
      imageData: input.buffer,
      uploadedBy: input.uploadedBy,
    },
  });
  return toMeta(row);
}

export async function listVouchers(_filter: {
  clientId: string | 'unassigned' | null;
}): Promise<VoucherMeta[]> {
  throw new Error('not implemented');
}

export async function getVoucherImage(
  _id: string,
): Promise<{ mimeType: string; data: Buffer } | null> {
  throw new Error('not implemented');
}

export async function deleteVoucher(_id: string): Promise<boolean> {
  throw new Error('not implemented');
}
```

- [ ] **Step 4: テストを走らせて createVoucher のみ通ることを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/services/voucher-service.test.ts -t "createVoucher"
```

Expected: createVoucher の 2 ケースが PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/src/services/voucher-service.ts server/tests/services/voucher-service.test.ts
git commit -m "feat(spec 10): voucher-service createVoucher with TDD"
```

---

## Task 4: voucher-service.ts listVouchers (TDD, 3 filter cases)

**Files:**
- Modify: `server/src/services/voucher-service.ts`
- Modify: `server/tests/services/voucher-service.test.ts`

- [ ] **Step 1: listVouchers の失敗テストを追加**

`server/tests/services/voucher-service.test.ts` の末尾に追加:

```ts
describe('listVouchers', () => {
  beforeEach(async () => {
    await createVoucher({
      clientId: 'aoyama-design',
      filename: 'a.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0x01]),
      uploadedBy: null,
    });
    await createVoucher({
      clientId: 'shibuya-cafe',
      filename: 'b.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0x02]),
      uploadedBy: null,
    });
    await createVoucher({
      clientId: null,
      filename: 'c.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0x03]),
      uploadedBy: null,
    });
  });

  it('filters by clientId cuid', async () => {
    const rows = await listVouchers({ clientId: 'aoyama-design' });
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('a.jpg');
  });

  it('returns unassigned (clientId IS NULL) when filter is "unassigned"', async () => {
    const rows = await listVouchers({ clientId: 'unassigned' });
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('c.jpg');
  });

  it('returns all rows when filter is null', async () => {
    const rows = await listVouchers({ clientId: null });
    expect(rows).toHaveLength(3);
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/services/voucher-service.test.ts -t "listVouchers"
```

Expected: 3 ケース全部 FAIL（`not implemented` エラー）。

- [ ] **Step 3: listVouchers を実装**

`server/src/services/voucher-service.ts` の `listVouchers` 本体を置き換え:

```ts
export async function listVouchers(filter: {
  clientId: string | 'unassigned' | null;
}): Promise<VoucherMeta[]> {
  const where =
    filter.clientId === null
      ? {}
      : filter.clientId === 'unassigned'
        ? { clientId: null }
        : { clientId: filter.clientId };
  const rows = await prisma.voucher.findMany({
    where,
    orderBy: { uploadedAt: 'desc' },
    select: {
      id: true,
      clientId: true,
      filename: true,
      mimeType: true,
      size: true,
      uploadedAt: true,
      uploadedBy: true,
      ocrStatus: true,
      matchStatus: true,
    },
  });
  return rows.map(toMeta);
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/services/voucher-service.test.ts -t "listVouchers"
```

Expected: 3 ケース全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/src/services/voucher-service.ts server/tests/services/voucher-service.test.ts
git commit -m "feat(spec 10): voucher-service listVouchers with 3 filter modes"
```

---

## Task 5: voucher-service.ts getVoucherImage + deleteVoucher (TDD)

**Files:**
- Modify: `server/src/services/voucher-service.ts`
- Modify: `server/tests/services/voucher-service.test.ts`

- [ ] **Step 1: 失敗テストを追加**

`server/tests/services/voucher-service.test.ts` の末尾に追加:

```ts
describe('getVoucherImage', () => {
  it('returns the raw bytes and mimeType', async () => {
    const buffer = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    const meta = await createVoucher({
      clientId: null,
      filename: 'g.gif',
      mimeType: 'image/gif',
      buffer,
      uploadedBy: null,
    });
    const image = await getVoucherImage(meta.id);
    expect(image).not.toBeNull();
    expect(image!.mimeType).toBe('image/gif');
    expect(image!.data).toEqual(buffer);
  });

  it('returns null when id is unknown', async () => {
    const image = await getVoucherImage('does-not-exist');
    expect(image).toBeNull();
  });
});

describe('deleteVoucher', () => {
  it('removes the row and returns true', async () => {
    const meta = await createVoucher({
      clientId: null,
      filename: 'd.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89]),
      uploadedBy: null,
    });
    const ok = await deleteVoucher(meta.id);
    expect(ok).toBe(true);
    const row = await prisma.voucher.findUnique({ where: { id: meta.id } });
    expect(row).toBeNull();
  });

  it('returns false when id is unknown', async () => {
    const ok = await deleteVoucher('does-not-exist');
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/services/voucher-service.test.ts
```

Expected: 新規 4 ケースが FAIL（`not implemented`）、既存 5 ケースは PASS のまま。

- [ ] **Step 3: getVoucherImage / deleteVoucher を実装**

`server/src/services/voucher-service.ts` の該当関数を置き換え:

```ts
export async function getVoucherImage(
  id: string,
): Promise<{ mimeType: string; data: Buffer } | null> {
  const row = await prisma.voucher.findUnique({
    where: { id },
    select: { mimeType: true, imageData: true },
  });
  if (!row) return null;
  return { mimeType: row.mimeType, data: Buffer.from(row.imageData) };
}

export async function deleteVoucher(id: string): Promise<boolean> {
  const result = await prisma.voucher.deleteMany({ where: { id } });
  return result.count > 0;
}
```

- [ ] **Step 4: テスト全体が通ることを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/services/voucher-service.test.ts
```

Expected: 9 ケース全部 PASS（createVoucher 2 + listVouchers 3 + getVoucherImage 2 + deleteVoucher 2）。spec で言う「サービス 6 ケース」より多いのは想定どおり（spec の数え方は緩めだったので 9 ケースで OK）。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/src/services/voucher-service.ts server/tests/services/voucher-service.test.ts
git commit -m "feat(spec 10): voucher-service getVoucherImage and deleteVoucher"
```

---

## Task 6: server.ts に @fastify/multipart を register

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: multipart を import + register**

`server/src/server.ts` の import 群に追加（既存 import 群の最後）:

```ts
import multipart from '@fastify/multipart';
```

そして `buildApp()` 内、`cors` register の直後に追加:

```ts
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });
```

- [ ] **Step 2: 既存テストが全部通ることを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run
```

Expected: 既存テスト全部 PASS（新規 voucher-service test 9 ケース込み）。multipart の register 失敗があれば即発覚する。

- [ ] **Step 3: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/src/server.ts
git commit -m "feat(spec 10): register @fastify/multipart with 10MB limit"
```

---

## Task 7: vouchers.ts POST /api/vouchers ルート (TDD, 3 ケース)

**Files:**
- Create: `server/src/routes/vouchers.ts`
- Create: `server/tests/routes/vouchers.test.ts`
- Modify: `server/src/server.ts` (route register)

- [ ] **Step 1: 失敗テストを書く（3 ケース）**

Create `server/tests/routes/vouchers.test.ts`:

```ts
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
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/routes/vouchers.test.ts
```

Expected: 全テストが 404 を返すか、モジュール解決エラーで失敗。

- [ ] **Step 3: ルートを実装**

Create `server/src/routes/vouchers.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { createVoucher } from '../services/voucher-service.js';

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export async function voucherRoutes(app: FastifyInstance) {
  app.post('/api/vouchers', async (req, reply) => {
    let data;
    try {
      data = await req.file();
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        reply.code(400);
        return {
          error: { code: 'FILE_TOO_LARGE', message: 'file exceeds 10MB' },
        };
      }
      throw err;
    }
    if (!data) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: 'file is required' } };
    }
    if (!ALLOWED_MIMES.has(data.mimetype)) {
      reply.code(400);
      return {
        error: {
          code: 'INVALID_MIME',
          message: `unsupported mime type: ${data.mimetype}`,
        },
      };
    }
    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        reply.code(400);
        return {
          error: { code: 'FILE_TOO_LARGE', message: 'file exceeds 10MB' },
        };
      }
      throw err;
    }
    const clientIdField = data.fields.clientId;
    const clientId =
      clientIdField && 'value' in clientIdField
        ? (clientIdField.value as string)
        : null;
    const uploadedBy =
      typeof req.headers['x-uploaded-by'] === 'string'
        ? req.headers['x-uploaded-by']
        : null;
    const meta = await createVoucher({
      clientId,
      filename: data.filename,
      mimeType: data.mimetype,
      buffer,
      uploadedBy,
    });
    reply.code(201);
    return meta;
  });
}
```

- [ ] **Step 4: server.ts に register を追加**

`server/src/server.ts` の import 群に追加:

```ts
import { voucherRoutes } from './routes/vouchers.js';
```

そして `buildApp()` 内の最後の `app.register(mfBooksRoutes);` の直後に追加:

```ts
  await app.register(voucherRoutes);
```

- [ ] **Step 5: テストを走らせて 3 ケースが通ることを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/routes/vouchers.test.ts
```

Expected: 3 ケース全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/src/routes/vouchers.ts server/src/server.ts server/tests/routes/vouchers.test.ts
git commit -m "feat(spec 10): POST /api/vouchers with MIME and size validation"
```

---

## Task 8: GET /api/vouchers + GET /api/vouchers/:id/image (TDD)

**Files:**
- Modify: `server/src/routes/vouchers.ts`
- Modify: `server/tests/routes/vouchers.test.ts`

- [ ] **Step 1: 失敗テストを追加**

`server/tests/routes/vouchers.test.ts` の末尾に追加:

```ts
describe('GET /api/vouchers', () => {
  it('returns rows filtered by clientId', async () => {
    await prisma.voucher.create({
      data: {
        clientId: 'aoyama-design',
        filename: 'x.png',
        mimeType: 'image/png',
        size: 3,
        imageData: Buffer.from([0x89, 0x50, 0x4e]),
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers?clientId=aoyama-design',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].filename).toBe('x.png');
    expect(body[0].imageData).toBeUndefined();
  });
});

describe('GET /api/vouchers/:id/image', () => {
  it('streams the raw bytes with original Content-Type', async () => {
    const created = await prisma.voucher.create({
      data: {
        clientId: null,
        filename: 'p.png',
        mimeType: 'image/png',
        size: 4,
        imageData: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/vouchers/${created.id}/image`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/routes/vouchers.test.ts
```

Expected: GET 2 ケースは 404 で FAIL、POST 3 ケースは PASS のまま。

- [ ] **Step 3: ルート 2 本を追加**

`server/src/routes/vouchers.ts` の `voucherRoutes` 関数内、POST の直後に追加:

```ts
  app.get<{
    Querystring: { clientId?: string };
  }>('/api/vouchers', async (req) => {
    const q = req.query.clientId;
    const filter: { clientId: string | 'unassigned' | null } = !q
      ? { clientId: null }
      : q === 'unassigned'
        ? { clientId: 'unassigned' }
        : { clientId: q };
    return listVouchers(filter);
  });

  app.get<{ Params: { id: string } }>(
    '/api/vouchers/:id/image',
    async (req, reply) => {
      const image = await getVoucherImage(req.params.id);
      if (!image) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      reply
        .header('content-type', image.mimeType)
        .header('cache-control', 'private, max-age=300');
      return image.data;
    },
  );
```

そして import 行を更新:

```ts
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
} from '../services/voucher-service.js';
```

- [ ] **Step 4: テストが通ることを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/routes/vouchers.test.ts
```

Expected: 5 ケース PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/src/routes/vouchers.ts server/tests/routes/vouchers.test.ts
git commit -m "feat(spec 10): GET /api/vouchers list and :id/image stream"
```

---

## Task 9: DELETE /api/vouchers/:id (TDD)

**Files:**
- Modify: `server/src/routes/vouchers.ts`
- Modify: `server/tests/routes/vouchers.test.ts`

- [ ] **Step 1: 失敗テストを追加**

`server/tests/routes/vouchers.test.ts` の末尾に追加:

```ts
describe('DELETE /api/vouchers/:id', () => {
  it('removes an existing voucher and returns ok: true', async () => {
    const created = await prisma.voucher.create({
      data: {
        clientId: null,
        filename: 'rm.jpg',
        mimeType: 'image/jpeg',
        size: 1,
        imageData: Buffer.from([0xff]),
      },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/vouchers/${created.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.voucher.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/vouchers/does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run tests/routes/vouchers.test.ts -t "DELETE"
```

Expected: 2 ケース FAIL（404 系のレスポンスが揃わない）。

- [ ] **Step 3: ルートを追加**

`server/src/routes/vouchers.ts` の voucherRoutes 関数内末尾に追加:

```ts
  app.delete<{ Params: { id: string } }>(
    '/api/vouchers/:id',
    async (req, reply) => {
      const ok = await deleteVoucher(req.params.id);
      if (!ok) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
      }
      return { ok: true };
    },
  );
```

import 行を更新:

```ts
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
  deleteVoucher,
} from '../services/voucher-service.js';
```

- [ ] **Step 4: 全テストが通ることを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run
```

Expected: 既存 + 新規（service 9 + route 7）全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add server/src/routes/vouchers.ts server/tests/routes/vouchers.test.ts
git commit -m "feat(spec 10): DELETE /api/vouchers/:id"
```

---

## Task 10: フロント appState + helper 関数

**Files:**
- Modify: `script.js`

- [ ] **Step 1: appState を拡張**

`script.js` 内の `appState` 定義箇所（先頭付近、`const appState = {` を探す）に以下のキーを追加（既存キーの直後に追加、末尾の `}` の前）:

```js
  vouchers: [],
  voucherTab: 'unassigned',
  voucherCounts: {},
  uploadQueue: [],
```

- [ ] **Step 2: 4 つの helper を定義する場所を確認**

`script.js` 内で既存の `async function loadAndRenderRules()` のような fetch ヘルパが並んでいる場所を探す（`grep -n "async function load" script.js`）。その近くに追加する。

- [ ] **Step 3: helper 関数を追加**

`script.js` の上記の helper 群と同じ場所（ファイル中盤、既存 fetch ラッパの近く）に追加:

```js
async function loadVouchers() {
  const tab = appState.voucherTab;
  const url =
    tab === 'unassigned'
      ? '/api/vouchers?clientId=unassigned'
      : `/api/vouchers?clientId=${encodeURIComponent(tab)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('list failed');
    appState.vouchers = await res.json();
    await refreshVoucherCounts();
    renderView();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function refreshVoucherCounts() {
  try {
    const res = await fetch('/api/vouchers');
    if (!res.ok) return;
    const all = await res.json();
    const counts = { unassigned: 0 };
    for (const v of all) {
      const key = v.clientId ?? 'unassigned';
      counts[key] = (counts[key] || 0) + 1;
    }
    appState.voucherCounts = counts;
  } catch (_err) {
    // counts are best-effort
  }
}

async function uploadVouchers(files) {
  const role =
    document.querySelector('#roleSelector')?.value || 'スタッフ';
  for (const file of files) {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
      showToast(`${file.name}: 対応していない形式です`);
      continue;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast(`${file.name}: ファイルが大きすぎます (上限 10MB)`);
      continue;
    }
    const tempId = 'tmp-' + Math.random().toString(36).slice(2);
    appState.uploadQueue.push({
      tempId,
      filename: file.name,
      status: 'uploading',
    });
    renderView();
    const form = new FormData();
    form.append('file', file);
    if (appState.voucherTab !== 'unassigned') {
      form.append('clientId', appState.voucherTab);
    }
    try {
      const res = await fetch('/api/vouchers', {
        method: 'POST',
        body: form,
        headers: { 'x-uploaded-by': role },
      });
      if (!res.ok) throw new Error('upload failed');
      const idx = appState.uploadQueue.findIndex((q) => q.tempId === tempId);
      if (idx >= 0) appState.uploadQueue.splice(idx, 1);
    } catch (_err) {
      const item = appState.uploadQueue.find((q) => q.tempId === tempId);
      if (item) item.status = 'failed';
      showToast(`${file.name}: アップロードに失敗しました`);
    }
  }
  await loadVouchers();
}

async function deleteVoucherById(id) {
  if (!confirm('この証憑を削除しますか？')) return;
  try {
    const res = await fetch(`/api/vouchers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed');
    await loadVouchers();
  } catch (err) {
    showToast(friendlyError(err));
  }
}
```

- [ ] **Step 4: ブラウザ目視で構文エラーが無いことを確認**

Run:
```bash
cd /home/kkouta/poc/bookmee
node --check script.js
```

Expected: エラー出力なし。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add script.js
git commit -m "feat(spec 10): voucher upload/list/delete helpers and appState"
```

---

## Task 11: renderVoucherRegister + renderView 配線

**Files:**
- Modify: `script.js`

- [ ] **Step 1: 既存 placeholder renderer を本実装に差し替え**

`script.js` 内の `views` map を探す（`grep -n '"vouchers-register":' script.js`）。現在の行:

```js
    "vouchers-register": () => `<section class="empty-view"><p>証憑登録はまだ準備中です。</p></section>`,
```

を以下に置き換え:

```js
    "vouchers-register": () => renderVoucherRegister(),
```

- [ ] **Step 2: renderVoucherRegister 本体を追加**

`script.js` 内の他の `function renderXxx()` が並ぶ場所（`grep -n "^function render" script.js` で探す）に追加:

```js
function renderVoucherRegister() {
  const tab = appState.voucherTab;
  const counts = appState.voucherCounts || {};
  // `clients` is the module-level array populated from /api/clients on startup
  const clientNameById = Object.fromEntries(
    (clients || []).map((c) => [c.id, c.name]),
  );

  // Build a tab for every clientId that has at least one voucher, even when
  // the client list hasn't loaded yet (fall back to cuid as the label).
  const clientIdsWithVouchers = Object.keys(counts).filter(
    (k) => k !== 'unassigned' && counts[k] > 0,
  );
  const tabClients = clientIdsWithVouchers.map((id) => ({
    id,
    name: clientNameById[id] || id,
    count: counts[id],
  }));

  const tabs = [
    {
      id: 'unassigned',
      label: '未分類',
      count: counts.unassigned || 0,
    },
    ...tabClients.map((c) => ({
      id: c.id,
      label: c.name,
      count: c.count,
    })),
  ];

  const tabHtml = tabs
    .map(
      (t) => `
      <button class="voucher-tab ${t.id === tab ? 'active' : ''}"
              data-voucher-tab="${t.id}">
        ${escapeHtml(t.label)} <span class="count">${t.count}</span>
      </button>
    `,
    )
    .join('');

  const uploadingCards = appState.uploadQueue
    .map(
      (q) => `
      <div class="voucher-card uploading">
        <div class="spinner"></div>
        <div class="voucher-filename">${escapeHtml(q.filename)}</div>
        <div class="voucher-status">${q.status === 'failed' ? '失敗' : 'アップロード中'}</div>
      </div>
    `,
    )
    .join('');

  const cards = (appState.vouchers || [])
    .map(
      (v) => `
      <div class="voucher-card" data-voucher-id="${v.id}">
        <img src="/api/vouchers/${v.id}/image" alt="${escapeHtml(v.filename)}" />
        <button class="voucher-delete" data-voucher-delete="${v.id}" aria-label="削除">×</button>
        <div class="voucher-meta">
          <div class="voucher-filename">${escapeHtml(v.filename)}</div>
          <div class="voucher-date">${new Date(v.uploadedAt).toLocaleString('ja-JP')}</div>
        </div>
      </div>
    `,
    )
    .join('');

  return `
    <section class="voucher-register">
      <div class="voucher-dropzone" id="voucherDropzone">
        <p class="voucher-dropzone-label">画像をここにドロップ または</p>
        <label class="voucher-pick-btn">
          ファイルを選択
          <input type="file" id="voucherFileInput" multiple
                 accept="image/jpeg,image/png,image/gif,image/webp" hidden />
        </label>
      </div>
      <div class="voucher-tabs">${tabHtml}</div>
      <div class="voucher-grid">
        ${uploadingCards}
        ${cards}
      </div>
    </section>
  `;
}

```

注: `escapeHtml` は既に line 1168 に定義済みなので再定義しない。`clients` は line 12 の module-level 変数で `/api/clients` の起動時取得結果が入る前提。

- [ ] **Step 3: renderView にイベント配線を追加**

`script.js` 内の `function renderView()` を探し、関数末尾の他の `if (appState.activeView === ...)` ブロックが並ぶ場所に追加:

```js
  if (appState.activeView === "vouchers-register") {
    loadVouchers();
    const dropzone = document.querySelector('#voucherDropzone');
    const fileInput = document.querySelector('#voucherFileInput');
    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length > 0) uploadVouchers(files);
      });
    }
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        if (files.length > 0) uploadVouchers(files);
        fileInput.value = '';
      });
    }
    viewContent.querySelectorAll('[data-voucher-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.voucherTab = btn.dataset.voucherTab;
        loadVouchers();
      });
    });
    viewContent.querySelectorAll('[data-voucher-delete]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteVoucherById(btn.dataset.voucherDelete);
      });
    });
  }
```

- [ ] **Step 4: 既存の labels.helper を実機文言に更新**

`script.js` 内の `"vouchers-register": "証憑をアップロードして登録します。"` を探し、そのままでも OK ですが、より正確に:

```js
    "vouchers-register": "領収書・請求書などの画像をまとめてアップロードします。未分類プールに入り、後で OCR で振り分けます。",
```

- [ ] **Step 5: 構文チェック**

Run:
```bash
cd /home/kkouta/poc/bookmee
node --check script.js
```

Expected: エラーなし。

- [ ] **Step 6: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add script.js
git commit -m "feat(spec 10): renderVoucherRegister with dropzone, tabs, grid"
```

---

## Task 12: styles.css 追加

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: styles.css 末尾に証憑関連のクラスを追加**

`styles.css` の末尾に追加:

```css
/* === Spec 10: 証憑登録 === */
.voucher-register {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.voucher-dropzone {
  border: 2px dashed #9ca3af;
  border-radius: 12px;
  padding: 32px;
  background: #f9fafb;
  text-align: center;
  transition: background 0.15s, border-color 0.15s;
}

.voucher-dropzone.dragover {
  background: #eef2ff;
  border-color: #6366f1;
}

.voucher-dropzone-label {
  margin: 0 0 12px;
  color: #6b7280;
  font-size: 14px;
}

.voucher-pick-btn {
  display: inline-block;
  padding: 8px 16px;
  background: #1f2937;
  color: #fff;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.voucher-pick-btn:hover {
  background: #111827;
}

.voucher-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid #e5e7eb;
  overflow-x: auto;
}

.voucher-tab {
  background: transparent;
  border: 0;
  padding: 8px 14px;
  font-size: 13px;
  color: #6b7280;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

.voucher-tab .count {
  display: inline-block;
  margin-left: 4px;
  padding: 1px 6px;
  background: #e5e7eb;
  border-radius: 9999px;
  font-size: 11px;
}

.voucher-tab.active {
  color: #111827;
  border-bottom-color: #dc2f55;
  font-weight: 600;
}

.voucher-tab.active .count {
  background: #fee2e2;
  color: #dc2f55;
}

.voucher-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
}

@media (max-width: 1100px) {
  .voucher-grid { grid-template-columns: repeat(4, 1fr); }
}

@media (max-width: 700px) {
  .voucher-grid { grid-template-columns: repeat(2, 1fr); }
}

.voucher-card {
  position: relative;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
  background: #fff;
  display: flex;
  flex-direction: column;
}

.voucher-card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
}

.voucher-card .voucher-meta {
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.4;
}

.voucher-card .voucher-filename {
  color: #111827;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.voucher-card .voucher-date {
  color: #9ca3af;
}

.voucher-delete {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 0;
  background: rgba(220, 47, 85, 0.9);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.voucher-card:hover .voucher-delete {
  opacity: 1;
}

.voucher-card.uploading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  aspect-ratio: 1;
  background: #f3f4f6;
  font-size: 11px;
  padding: 8px;
  text-align: center;
}

.voucher-card.uploading .spinner {
  width: 24px;
  height: 24px;
  border: 3px solid #e5e7eb;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: voucher-spin 0.8s linear infinite;
  margin-bottom: 6px;
}

@keyframes voucher-spin {
  to { transform: rotate(360deg); }
}

.voucher-card.uploading .voucher-status {
  color: #6b7280;
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add styles.css
git commit -m "feat(spec 10): styles for voucher register dropzone, tabs, grid"
```

---

## Task 13: 手動 UI 検証

**Files:**
- (Read-only verification)

- [ ] **Step 1: サーバ起動**

Run:
```bash
cd /home/kkouta/poc/bookmee
docker compose up -d postgres
cd server
npm run dev
```

別ターミナルで:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

Expected: `200`。

- [ ] **Step 2: ブラウザで動作確認**

http://localhost:3000/ を開く。

サイドバー「証憑登録」をクリック。

確認:
1. ドロップゾーン、タブ（未分類 0）、空のグリッドが見える
2. JPEG/PNG を D&D → アップロード中プレースホルダ → サムネ表示
3. HEIC を D&D → トーストに「対応していない形式です」
4. 11MB の画像を D&D → トーストに「ファイルが大きすぎます (上限 10MB)」
5. サムネにホバー → 右上に赤い × → クリック → confirm → 削除される
6. サムネをクリック → 原寸モーダル（既存のモーダルパターンが効いていれば自動）。**モーダル動作が無ければ Task 14 で追加実装が必要**
7. 顧問先タブ（青山デザイン等）に切り替え → 0 件
8. 顧問先タブ選択中に画像を D&D → そのタブに紐づく
9. 「未分類」タブに戻って画像が無くなっていることを確認

- [ ] **Step 3: モーダル動作のチェック**

サムネクリック動作を確認。`appState.activeView === 'vouchers-register'` 中にクリックハンドラが設定されていないので、現状クリックは何もしない。**spec の「クリックで原寸モーダル」を満たすには Task 14 が必要**。

- [ ] **Step 4: Commit (なし、確認のみ)**

このタスクではコミットしない。発見事項は次タスクへ。

---

## Task 14: サムネクリック時の原寸モーダル

**Files:**
- Modify: `script.js`
- Modify: `styles.css`

spec の「サムネクリックで原寸モーダル」要件を満たす。

- [ ] **Step 1: モーダル DOM をビュー HTML に追加**

`script.js` の `renderVoucherRegister()` の return 文末（`</section>` の直前）に追加:

```js
      <div class="voucher-modal" id="voucherModal" hidden>
        <div class="voucher-modal-backdrop"></div>
        <img id="voucherModalImg" alt="" />
        <button class="voucher-modal-close" id="voucherModalClose" aria-label="閉じる">×</button>
      </div>
```

- [ ] **Step 2: renderView の vouchers-register ブロックにクリック配線を追加**

Task 11 で追加した `if (appState.activeView === "vouchers-register") { ... }` ブロック内の `viewContent.querySelectorAll('[data-voucher-delete]')` の直後に追加:

```js
    viewContent.querySelectorAll('[data-voucher-id]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-voucher-delete]')) return;
        const id = card.dataset.voucherId;
        const modal = document.querySelector('#voucherModal');
        const img = document.querySelector('#voucherModalImg');
        if (modal && img) {
          img.src = `/api/vouchers/${id}/image`;
          modal.hidden = false;
        }
      });
    });
    const closeBtn = document.querySelector('#voucherModalClose');
    const backdrop = document.querySelector('.voucher-modal-backdrop');
    const closeModal = () => {
      const m = document.querySelector('#voucherModal');
      if (m) m.hidden = true;
    };
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (backdrop) backdrop.addEventListener('click', closeModal);
```

- [ ] **Step 3: styles.css にモーダルスタイルを追加**

`styles.css` の末尾に追加:

```css
.voucher-modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.voucher-modal[hidden] {
  display: none;
}

.voucher-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
}

.voucher-modal img {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 8px;
}

.voucher-modal-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  color: #111827;
  font-size: 18px;
  cursor: pointer;
}
```

- [ ] **Step 4: ブラウザで再確認**

http://localhost:3000/ の証憑登録ビューで、サムネをクリック → モーダル表示、× / 背景クリック → 閉じる。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee
git add script.js styles.css
git commit -m "feat(spec 10): voucher thumbnail click opens full-size modal"
```

---

## Task 15: 全体回帰確認

**Files:**
- (Read-only verification)

- [ ] **Step 1: 全テストを走らせる**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx vitest run
```

Expected: 既存テスト + 新規 service 9 + route 7 のすべてが PASS。

- [ ] **Step 2: 型チェック**

Run:
```bash
cd /home/kkouta/poc/bookmee/server
npx tsc --noEmit
```

Expected: 既存の TS エラー（spec 10 とは無関係の `routes/mode.ts`, `server.ts` の overload エラー）は残るが、新規 voucher 関連で**新たなエラーは出ない**こと。

- [ ] **Step 3: 受入基準チェックリストを目視で確認**

spec 10 の「受入基準」セクション（`docs/superpowers/specs/2026-05-18-10-voucher-registration-design.md`）を開き、12 項目すべてが満たされていることを確認:

- [ ] prisma:migrate で Voucher テーブル作成
- [ ] POST /api/vouchers で multipart 保存 (JPG/PNG/GIF/WebP)
- [ ] HEIC / PDF / 11MB 以上は 400 拒否
- [ ] GET /api/vouchers?clientId=unassigned で未分類のみ
- [ ] GET /api/vouchers?clientId=<cuid> で顧問先別
- [ ] GET /api/vouchers/:id/image で Content-Type 付き原寸
- [ ] DELETE /api/vouchers/:id で削除
- [ ] D&D で複数ファイル UP できる
- [ ] アップロード中プレースホルダ
- [ ] タブ切替で表示が変わる
- [ ] サムネクリックで原寸モーダル
- [ ] サムネホバーで削除ボタン → 削除

- [ ] **Step 4: 完了コミット**

すべて OK なら何もコミットせず終了。受入基準で漏れがあれば対応タスクを追加。
