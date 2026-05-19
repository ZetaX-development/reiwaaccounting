# Spec 16 (公式 LINE Messaging API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** スタッフが LINE 公式アカウントで画像 + 説明テキストを送るだけで Voucher が作成され、既存 OCR/振り分け/突合/ドラフト仕訳パイプラインに乗る。突合不一致時は LINE に Push + Quick Reply でスタッフに確認する。

**Architecture:** webhook 受信 → 署名検証 → `line-importer` で event 毎に処理（follow / image / text / postback）。画像は Content API でバイナリ取得 → `voucher-service.createVoucher` → 既存パイプライン。caption は 60 秒 in-memory cache で text と image を紐付け。Push API は `voucher-service.assignAndMatchVoucher` 末尾にフック追加して OCR/突合完了時に発火。

**Tech Stack:** Fastify 5 + Prisma 6 + Postgres 16 + Vitest 3 + `node:crypto` + `undici`

**Spec:** `docs/superpowers/specs/2026-05-19-16-voucher-inbound-line-design.md`

**ファイル構成（全タッチ）**

- 新規 `server/src/services/line-service.ts` — LINE API ラッパ（署名検証 / bot info / content / profile / reply / push / pushQuickReply）
- 新規 `server/src/services/line-importer.ts` — `handleWebhookEvents` + caption cache
- 新規 `server/src/services/line-mapping-service.ts` — LineUserMapping CRUD
- 新規 `server/src/routes/integrations-line.ts` — 6 endpoints
- 新規 `server/tests/services/line-service.test.ts`
- 新規 `server/tests/services/line-importer.test.ts`
- 新規 `server/tests/routes/integrations-line.test.ts`
- 修正 `server/prisma/schema.prisma` — LineUserMapping + Voucher 拡張
- 修正 `server/src/env.ts` — LINE_* 4 つ追加
- 修正 `server/.env.example` — LINE_* 追記
- 修正 `server/src/server.ts` — `integrationsLineRoutes` register、raw body 設定
- 修正 `server/src/services/voucher-service.ts` — `assignAndMatchVoucher` 末尾に LINE Push フック
- 修正 `index.html` — 左ナビ + view container
- 修正 `script.js` — 接続パネル / users mapping / source/caption バッジ
- 修正 `styles.css` — 新ビュー + line バッジ

---

## Task 1: Prisma スキーマ + Voucher 拡張

**Files:**
- Modify: `server/prisma/schema.prisma`

- [ ] **Step 1: Voucher に新規 4 列を追加**

`server/prisma/schema.prisma` の `model Voucher` ブロック内、`inquiries VoucherInquiry[]` の直前に追加：

```prisma
  // Spec 16: 公式 LINE Messaging API 連携用
  source              String   @default("manual")
  lineSourceMessageId String?  @unique
  lineUserId          String?
  caption             String?
```

注: `source` 列は spec 15 (Drive) も使う予定の汎用列。本 spec で初出させる。

- [ ] **Step 2: ファイル末尾に LineUserMapping を追加**

`server/prisma/schema.prisma` 末尾に：

```prisma
model LineUserMapping {
  id          String   @id @default(cuid())
  lineUserId  String   @unique
  displayName String
  staffLabel  String?
  enabled     Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 3: マイグレーション**

```bash
cd /home/kkouta/poc/bookmee/server && npx prisma migrate dev --name spec16_line_inbound
```
Expected: `Applied migration ... spec16_line_inbound`、Prisma Client 再生成。

- [ ] **Step 4: 確認**

```bash
PGPASSWORD=bookmee_dev psql -h localhost -U bookmee -d bookmee -c "\d \"LineUserMapping\""
PGPASSWORD=bookmee_dev psql -h localhost -U bookmee -d bookmee -c "\d \"Voucher\"" | grep -E "source|lineSourceMessageId|lineUserId|caption"
```
LineUserMapping テーブルが見え、Voucher に 4 列が追加されていることを確認。

```bash
cd /home/kkouta/poc/bookmee/server && npm test 2>&1 | tail -5
```
Expected: 全 94 テスト PASS（既存挙動を壊していないこと）。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat(spec 16): add LineUserMapping + Voucher source/lineSourceMessageId/lineUserId/caption

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: env vars + .env.example

**Files:**
- Modify: `server/src/env.ts`
- Modify: `server/.env.example`

- [ ] **Step 1: env.ts に LINE_* を追加**

`server/src/env.ts` の `OPENAI_VISION_MODEL` の次行付近に追加：

```ts
  LINE_CHANNEL_ACCESS_TOKEN: z.string().default(''),
  LINE_CHANNEL_SECRET: z.string().default(''),
  LINE_WEBHOOK_BASE_URL: z.string().default(''),
  LINE_CHANNEL_ID: z.string().default(''),
```

- [ ] **Step 2: .env.example に追記**

`server/.env.example` の末尾に追加：

```
# Spec 16: 公式 LINE Messaging API (スタッフ用)
# LINE Developers Console で取得: https://developers.line.biz/console/
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
LINE_WEBHOOK_BASE_URL=
LINE_CHANNEL_ID=
```

- [ ] **Step 3: tsc 通過確認**

```bash
cd /home/kkouta/poc/bookmee/server && npm run build 2>&1 | tail -5
```
Expected: エラー無し。

- [ ] **Step 4: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/env.ts server/.env.example
git commit -m "feat(spec 16): add LINE_* env vars (channel access token / secret / webhook base / channel id)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: line-service の署名検証 (TDD)

**Files:**
- Create: `server/src/services/line-service.ts`
- Create: `server/tests/services/line-service.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/services/line-service.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySignature } from '../../src/services/line-service.js';

describe('verifySignature', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"events":[]}');
  const correctSig = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');

  it('returns true for correct signature', () => {
    expect(verifySignature(secret, body, correctSig)).toBe(true);
  });

  it('returns false for incorrect signature', () => {
    expect(verifySignature(secret, body, 'wrong-signature')).toBe(false);
  });

  it('returns false for empty signature', () => {
    expect(verifySignature(secret, body, '')).toBe(false);
  });

  it('returns false for empty secret', () => {
    expect(verifySignature('', body, correctSig)).toBe(false);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-service.test.ts
```
Expected: FAIL — `Cannot find module '.../line-service.js'`。

- [ ] **Step 3: 最小実装**

`server/src/services/line-service.ts`:

```ts
import crypto from 'node:crypto';

export function verifySignature(
  channelSecret: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  if (!channelSecret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', channelSecret)
    .update(rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-service.test.ts
```
Expected: 4 ケース PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/services/line-service.ts server/tests/services/line-service.test.ts
git commit -m "feat(spec 16): line-service verifySignature with timing-safe compare

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: line-service の残りラッパ（ユニットテストなし）

**Files:**
- Modify: `server/src/services/line-service.ts`

**Note:** LINE API への薄いラッパなのでユニットテストは line-importer / routes 側で spy する（既存 mf-api / drive-service と同方針）。

- [ ] **Step 1: line-service.ts に追記**

`server/src/services/line-service.ts` に以下を追加（既存の `verifySignature` の後ろ）：

```ts
import { request } from 'undici';
import { env } from '../env.js';

const LINE_API_BASE = 'https://api.line.me';
const LINE_DATA_API_BASE = 'https://api-data.line.me';

function bearer(): { authorization: string } {
  return { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
}

export interface LineBotInfo {
  userId: string;
  basicId: string;
  displayName: string;
  pictureUrl?: string;
  chatMode: string;
  markAsReadMode: string;
}

export async function getBotInfo(): Promise<LineBotInfo> {
  const res = await request(`${LINE_API_BASE}/v2/bot/info`, {
    method: 'GET',
    headers: bearer(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`getBotInfo failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
  return (await res.body.json()) as LineBotInfo;
}

export async function getMessageContent(messageId: string): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const res = await request(
    `${LINE_DATA_API_BASE}/v2/bot/message/${messageId}/content`,
    { method: 'GET', headers: bearer() },
  );
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(
      `getMessageContent failed: ${res.statusCode} ${text.slice(0, 200)}`,
    );
  }
  const contentType =
    (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
  const ab = await res.body.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType };
}

export interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
  statusMessage?: string;
}

export async function getProfile(userId: string): Promise<LineProfile> {
  const res = await request(`${LINE_API_BASE}/v2/bot/profile/${userId}`, {
    method: 'GET',
    headers: bearer(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`getProfile failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
  return (await res.body.json()) as LineProfile;
}

export interface LineMessage {
  type: 'text';
  text: string;
  quickReply?: {
    items: Array<{
      type: 'action';
      action: { type: 'postback'; label: string; data: string; displayText?: string };
    }>;
  };
}

export async function replyMessage(
  replyToken: string,
  messages: LineMessage[],
): Promise<void> {
  const res = await request(`${LINE_API_BASE}/v2/bot/message/reply`, {
    method: 'POST',
    headers: {
      ...bearer(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`replyMessage failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
}

export async function pushMessage(
  toUserId: string,
  messages: LineMessage[],
): Promise<void> {
  const res = await request(`${LINE_API_BASE}/v2/bot/message/push`, {
    method: 'POST',
    headers: {
      ...bearer(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ to: toUserId, messages }),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(`pushMessage failed: ${res.statusCode} ${text.slice(0, 200)}`);
  }
}

export interface QuickReplyItem {
  label: string;
  data: string;
}

export async function pushQuickReply(
  toUserId: string,
  text: string,
  items: QuickReplyItem[],
): Promise<void> {
  return pushMessage(toUserId, [
    {
      type: 'text',
      text,
      quickReply: {
        items: items.map((i) => ({
          type: 'action',
          action: { type: 'postback', label: i.label, data: i.data, displayText: i.label },
        })),
      },
    },
  ]);
}
```

- [ ] **Step 2: tsc 通過 + 既存テスト維持**

```bash
cd /home/kkouta/poc/bookmee/server && npm run build && npx vitest run tests/services/line-service.test.ts
```
Expected: build エラー無し、4 テスト PASS。

- [ ] **Step 3: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/services/line-service.ts
git commit -m "feat(spec 16): line-service wrappers (getBotInfo / getMessageContent / getProfile / replyMessage / pushMessage / pushQuickReply)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: line-mapping-service の CRUD (TDD)

**Files:**
- Create: `server/src/services/line-mapping-service.ts`
- Create: `server/tests/services/line-mapping-service.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/services/line-mapping-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  upsertLineUser,
  setLineUserEnabled,
  setLineUserLabel,
  deleteLineUser,
  listLineUsers,
  getLineUser,
} from '../../src/services/line-mapping-service.js';

beforeEach(async () => {
  await prisma.lineUserMapping.deleteMany();
});

afterAll(async () => {
  await prisma.lineUserMapping.deleteMany();
  await prisma.$disconnect();
});

describe('upsertLineUser', () => {
  it('creates a new row with enabled=false by default', async () => {
    const row = await upsertLineUser({
      lineUserId: 'U123',
      displayName: 'Alice',
    });
    expect(row.lineUserId).toBe('U123');
    expect(row.displayName).toBe('Alice');
    expect(row.enabled).toBe(false);
  });

  it('does not overwrite enabled on second upsert', async () => {
    await upsertLineUser({ lineUserId: 'U1', displayName: 'A' });
    await setLineUserEnabled('U1', true);
    await upsertLineUser({ lineUserId: 'U1', displayName: 'A-updated' });
    const row = await getLineUser('U1');
    expect(row?.enabled).toBe(true);
    expect(row?.displayName).toBe('A-updated');
  });
});

describe('setLineUserEnabled / setLineUserLabel / deleteLineUser', () => {
  it('toggles enabled', async () => {
    await upsertLineUser({ lineUserId: 'U1', displayName: 'A' });
    await setLineUserEnabled('U1', true);
    expect((await getLineUser('U1'))?.enabled).toBe(true);
    await setLineUserEnabled('U1', false);
    expect((await getLineUser('U1'))?.enabled).toBe(false);
  });

  it('updates staffLabel', async () => {
    await upsertLineUser({ lineUserId: 'U1', displayName: 'A' });
    await setLineUserLabel('U1', '所長');
    expect((await getLineUser('U1'))?.staffLabel).toBe('所長');
  });

  it('deletes by id and returns true', async () => {
    const row = await upsertLineUser({ lineUserId: 'U1', displayName: 'A' });
    expect(await deleteLineUser(row.id)).toBe(true);
    expect(await getLineUser('U1')).toBeNull();
  });
});

describe('listLineUsers', () => {
  it('returns all rows ordered by createdAt asc', async () => {
    await upsertLineUser({ lineUserId: 'U1', displayName: 'A' });
    await upsertLineUser({ lineUserId: 'U2', displayName: 'B' });
    const rows = await listLineUsers();
    expect(rows).toHaveLength(2);
    expect(rows[0].lineUserId).toBe('U1');
    expect(rows[1].lineUserId).toBe('U2');
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-mapping-service.test.ts
```
Expected: FAIL。

- [ ] **Step 3: 実装**

`server/src/services/line-mapping-service.ts`:

```ts
import { prisma } from '../lib/prisma.js';
import type { LineUserMapping } from '@prisma/client';

export async function upsertLineUser(input: {
  lineUserId: string;
  displayName: string;
}): Promise<LineUserMapping> {
  return prisma.lineUserMapping.upsert({
    where: { lineUserId: input.lineUserId },
    create: {
      lineUserId: input.lineUserId,
      displayName: input.displayName,
    },
    update: {
      displayName: input.displayName,
    },
  });
}

export async function getLineUser(
  lineUserId: string,
): Promise<LineUserMapping | null> {
  return prisma.lineUserMapping.findUnique({ where: { lineUserId } });
}

export async function listLineUsers(): Promise<LineUserMapping[]> {
  return prisma.lineUserMapping.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function setLineUserEnabled(
  lineUserId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.lineUserMapping.updateMany({
    where: { lineUserId },
    data: { enabled },
  });
}

export async function setLineUserLabel(
  lineUserId: string,
  staffLabel: string | null,
): Promise<void> {
  await prisma.lineUserMapping.updateMany({
    where: { lineUserId },
    data: { staffLabel },
  });
}

export async function deleteLineUser(id: string): Promise<boolean> {
  const r = await prisma.lineUserMapping.deleteMany({ where: { id } });
  return r.count > 0;
}
```

- [ ] **Step 4: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-mapping-service.test.ts
```
Expected: 全ケース PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/services/line-mapping-service.ts server/tests/services/line-mapping-service.test.ts
git commit -m "feat(spec 16): line-mapping-service CRUD for LineUserMapping

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: line-importer の follow / unfollow (TDD)

**Files:**
- Create: `server/src/services/line-importer.ts`
- Create: `server/tests/services/line-importer.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/services/line-importer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { handleWebhookEvents } from '../../src/services/line-importer.js';
import * as lineService from '../../src/services/line-service.js';

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  await prisma.lineUserMapping.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.lineUserMapping.deleteMany();
  await prisma.$disconnect();
});

describe('handleWebhookEvents - follow', () => {
  it('creates LineUserMapping with enabled=false and sends welcome reply', async () => {
    vi.spyOn(lineService, 'getProfile').mockResolvedValue({
      userId: 'U1',
      displayName: 'Alice',
    });
    const replySpy = vi
      .spyOn(lineService, 'replyMessage')
      .mockResolvedValue();
    await handleWebhookEvents([
      {
        type: 'follow',
        replyToken: 'RT1',
        source: { userId: 'U1' },
        timestamp: Date.now(),
      },
    ]);
    const row = await prisma.lineUserMapping.findUnique({
      where: { lineUserId: 'U1' },
    });
    expect(row?.enabled).toBe(false);
    expect(row?.displayName).toBe('Alice');
    expect(replySpy).toHaveBeenCalledWith(
      'RT1',
      expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
      ]),
    );
  });
});

describe('handleWebhookEvents - unfollow', () => {
  it('sets enabled=false on existing mapping', async () => {
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A', enabled: true },
    });
    await handleWebhookEvents([
      { type: 'unfollow', source: { userId: 'U1' }, timestamp: Date.now() },
    ]);
    const row = await prisma.lineUserMapping.findUnique({
      where: { lineUserId: 'U1' },
    });
    expect(row?.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-importer.test.ts
```
Expected: FAIL — module 未定義。

- [ ] **Step 3: 最小実装**

`server/src/services/line-importer.ts`:

```ts
import { logger } from '../lib/logger.js';
import {
  upsertLineUser,
  getLineUser,
  setLineUserEnabled,
} from './line-mapping-service.js';
import * as lineService from './line-service.js';

export interface LineEventSource {
  userId?: string;
  type?: string;
}

export interface LineMessageObj {
  id: string;
  type: 'text' | 'image' | 'sticker' | 'video' | 'audio' | 'file' | 'location';
  text?: string;
}

export interface LineEvent {
  type: string;
  replyToken?: string;
  source: LineEventSource;
  timestamp: number;
  message?: LineMessageObj;
  postback?: { data: string };
}

export async function handleWebhookEvents(events: LineEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await handleSingleEvent(event);
    } catch (err) {
      logger.warn({ err, event }, 'line event handler failed');
    }
  }
}

async function handleSingleEvent(event: LineEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  if (event.type === 'follow') {
    let displayName = 'unknown';
    try {
      const profile = await lineService.getProfile(userId);
      displayName = profile.displayName ?? 'unknown';
    } catch {
      // best-effort
    }
    await upsertLineUser({ lineUserId: userId, displayName });
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        {
          type: 'text',
          text:
            '事務所スタッフ承認待ちです。所長が承認すると画像受付を開始します。',
        },
      ]);
    }
    return;
  }

  if (event.type === 'unfollow') {
    await setLineUserEnabled(userId, false);
    return;
  }
}
```

- [ ] **Step 4: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-importer.test.ts
```
Expected: 2 ケース PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/services/line-importer.ts server/tests/services/line-importer.test.ts
git commit -m "feat(spec 16): line-importer handles follow/unfollow events

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: line-importer の image happy path + caption (TDD)

**Files:**
- Modify: `server/src/services/line-importer.ts`
- Modify: `server/tests/services/line-importer.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/line-importer.test.ts` の末尾に追加：

```ts
describe('handleWebhookEvents - image from enabled user', () => {
  beforeEach(async () => {
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A', enabled: true },
    });
  });

  it('creates Voucher with source=line, lineSourceMessageId, lineUserId', async () => {
    vi.spyOn(lineService, 'getMessageContent').mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      contentType: 'image/jpeg',
    });
    process.env.OPENAI_API_KEY = '';
    await handleWebhookEvents([
      {
        type: 'message',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        message: { id: 'M1', type: 'image' },
      },
    ]);
    const v = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'M1' },
    });
    expect(v).not.toBeNull();
    expect(v?.source).toBe('line');
    expect(v?.lineUserId).toBe('U1');
    expect(v?.mimeType).toBe('image/jpeg');
    expect(v?.uploadedBy).toBe('line');
  });

  it('attaches caption when text was sent earlier in same batch', async () => {
    vi.spyOn(lineService, 'getMessageContent').mockResolvedValue({
      buffer: Buffer.from([0xff]),
      contentType: 'image/jpeg',
    });
    process.env.OPENAI_API_KEY = '';
    await handleWebhookEvents([
      {
        type: 'message',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        message: { id: 'TXT1', type: 'text', text: '青山デザイン 5/15 タクシー代' },
      },
      {
        type: 'message',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        message: { id: 'IMG1', type: 'image' },
      },
    ]);
    const v = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'IMG1' },
    });
    expect(v?.caption).toBe('青山デザイン 5/15 タクシー代');
  });

  it('attaches caption when text was sent AFTER image (same batch)', async () => {
    vi.spyOn(lineService, 'getMessageContent').mockResolvedValue({
      buffer: Buffer.from([0xff]),
      contentType: 'image/jpeg',
    });
    process.env.OPENAI_API_KEY = '';
    await handleWebhookEvents([
      {
        type: 'message',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        message: { id: 'IMG2', type: 'image' },
      },
      {
        type: 'message',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        message: { id: 'TXT2', type: 'text', text: '橋本商店 5/16 接待' },
      },
    ]);
    const v = await prisma.voucher.findUnique({
      where: { lineSourceMessageId: 'IMG2' },
    });
    expect(v?.caption).toBe('橋本商店 5/16 接待');
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-importer.test.ts -t image
```
Expected: 3 ケース FAIL。

- [ ] **Step 3: 実装を拡張**

`server/src/services/line-importer.ts` を以下に置き換え（既存 follow/unfollow も含む）：

```ts
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import {
  upsertLineUser,
  getLineUser,
  setLineUserEnabled,
} from './line-mapping-service.js';
import * as lineService from './line-service.js';
import { createVoucher, runOcrForVoucher } from './voucher-service.js';

const CAPTION_TTL_MS = 60_000;
const captionCache = new Map<string, { text: string; capturedAt: number }>();

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const MAX_SIZE = 10 * 1024 * 1024;

export interface LineEventSource {
  userId?: string;
  type?: string;
}

export interface LineMessageObj {
  id: string;
  type: 'text' | 'image' | 'sticker' | 'video' | 'audio' | 'file' | 'location';
  text?: string;
}

export interface LineEvent {
  type: string;
  replyToken?: string;
  source: LineEventSource;
  timestamp: number;
  message?: LineMessageObj;
  postback?: { data: string };
}

export async function handleWebhookEvents(events: LineEvent[]): Promise<void> {
  // 同 batch 内で同 user の text を image より前に処理してキャッシュに入れる。
  // text → image 順序: 自然にそのまま処理 → キャッシュ → image が pop
  // image → text 順序: 一旦並べ替える。image を見つけたら同 user の以降の text を先取り
  const reordered = reorderForCaptionMatching(events);
  for (const event of reordered) {
    try {
      await handleSingleEvent(event);
    } catch (err) {
      logger.warn({ err, event }, 'line event handler failed');
    }
  }
}

function reorderForCaptionMatching(events: LineEvent[]): LineEvent[] {
  // 同 user の (image, text) ペアを (text, image) 順に並べ替える。
  // ペアが既に (text, image) 順なら何もしない。
  const result: LineEvent[] = [];
  const consumedTextIndex = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    if (consumedTextIndex.has(i)) continue;
    const e = events[i];
    if (
      e.type === 'message' &&
      e.message?.type === 'image' &&
      e.source.userId
    ) {
      // 後方を見て同 user の最初の text を探す
      let pairedTextIdx: number | null = null;
      for (let j = i + 1; j < events.length; j++) {
        const f = events[j];
        if (consumedTextIndex.has(j)) continue;
        if (
          f.type === 'message' &&
          f.message?.type === 'text' &&
          f.source.userId === e.source.userId
        ) {
          pairedTextIdx = j;
          break;
        }
      }
      if (pairedTextIdx !== null) {
        result.push(events[pairedTextIdx]);
        consumedTextIndex.add(pairedTextIdx);
      }
      result.push(e);
    } else {
      result.push(e);
    }
  }
  return result;
}

async function handleSingleEvent(event: LineEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  if (event.type === 'follow') {
    let displayName = 'unknown';
    try {
      const profile = await lineService.getProfile(userId);
      displayName = profile.displayName ?? 'unknown';
    } catch {
      // best-effort
    }
    await upsertLineUser({ lineUserId: userId, displayName });
    if (event.replyToken) {
      await lineService.replyMessage(event.replyToken, [
        {
          type: 'text',
          text:
            '事務所スタッフ承認待ちです。所長が承認すると画像受付を開始します。',
        },
      ]);
    }
    return;
  }

  if (event.type === 'unfollow') {
    await setLineUserEnabled(userId, false);
    return;
  }

  if (event.type === 'message' && event.message) {
    if (event.message.type === 'text' && event.message.text) {
      captionCache.set(userId, {
        text: event.message.text,
        capturedAt: Date.now(),
      });
      return;
    }
    if (event.message.type === 'image') {
      await handleImageMessage(event, userId, event.message.id);
      return;
    }
    return;
  }
}

async function handleImageMessage(
  event: LineEvent,
  userId: string,
  messageId: string,
): Promise<void> {
  const mapping = await getLineUser(userId);
  if (!mapping || !mapping.enabled) {
    // 未登録 or 無効
    if (!mapping) {
      let displayName = 'unknown';
      try {
        const profile = await lineService.getProfile(userId);
        displayName = profile.displayName ?? 'unknown';
      } catch {
        // best-effort
      }
      await upsertLineUser({ lineUserId: userId, displayName });
    }
    if (event.replyToken) {
      await lineService
        .replyMessage(event.replyToken, [
          { type: 'text', text: '承認待ちのため画像を受け付けられません。' },
        ])
        .catch(() => {});
    }
    return;
  }

  const existing = await prisma.voucher.findUnique({
    where: { lineSourceMessageId: messageId },
  });
  if (existing) return; // 冪等

  const content = await lineService.getMessageContent(messageId);
  if (!ALLOWED_IMAGE_MIMES.has(content.contentType.split(';')[0].trim())) {
    if (event.replyToken) {
      await lineService
        .replyMessage(event.replyToken, [
          { type: 'text', text: '画像形式が非対応です (JPG/PNG のみ)。' },
        ])
        .catch(() => {});
    }
    return;
  }
  if (content.buffer.byteLength > MAX_SIZE) {
    if (event.replyToken) {
      await lineService
        .replyMessage(event.replyToken, [
          { type: 'text', text: 'ファイルサイズが大きすぎます (10MB 以下)。' },
        ])
        .catch(() => {});
    }
    return;
  }

  const cached = captionCache.get(userId);
  let caption: string | null = null;
  if (cached && Date.now() - cached.capturedAt < CAPTION_TTL_MS) {
    caption = cached.text;
  }
  captionCache.delete(userId);

  const meta = await createVoucher({
    clientId: null,
    filename: `line-${messageId}.jpg`,
    mimeType: content.contentType.split(';')[0].trim(),
    buffer: content.buffer,
    uploadedBy: 'line',
  });
  await prisma.voucher.update({
    where: { id: meta.id },
    data: {
      source: 'line',
      lineSourceMessageId: messageId,
      lineUserId: userId,
      caption,
    },
  });

  if (process.env.OPENAI_API_KEY) {
    setImmediate(() => {
      runOcrForVoucher(meta.id).catch(() => {});
    });
  }
}
```

- [ ] **Step 4: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-importer.test.ts
```
Expected: 5 ケース PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/services/line-importer.ts server/tests/services/line-importer.test.ts
git commit -m "feat(spec 16): line-importer handles image messages with caption matching

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: line-importer の skip ケース (TDD)

**Files:**
- Modify: `server/tests/services/line-importer.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/line-importer.test.ts` の末尾に追加：

```ts
describe('handleWebhookEvents - skip cases', () => {
  it('is idempotent: duplicate messageId does not create a 2nd Voucher', async () => {
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A', enabled: true },
    });
    const getContentSpy = vi
      .spyOn(lineService, 'getMessageContent')
      .mockResolvedValue({
        buffer: Buffer.from([0xff]),
        contentType: 'image/jpeg',
      });
    // 1st
    await handleWebhookEvents([
      {
        type: 'message',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        message: { id: 'DUP1', type: 'image' },
      },
    ]);
    expect(await prisma.voucher.count({ where: { lineSourceMessageId: 'DUP1' } })).toBe(1);
    // 2nd (same id)
    await handleWebhookEvents([
      {
        type: 'message',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        message: { id: 'DUP1', type: 'image' },
      },
    ]);
    expect(await prisma.voucher.count({ where: { lineSourceMessageId: 'DUP1' } })).toBe(1);
    // getMessageContent was only called for the first event
    expect(getContentSpy).toHaveBeenCalledTimes(1);
  });

  it('auto-creates LineUserMapping with enabled=false for unregistered user image and skips voucher', async () => {
    vi.spyOn(lineService, 'getProfile').mockResolvedValue({
      userId: 'Unew',
      displayName: 'NewUser',
    });
    const getContentSpy = vi.spyOn(lineService, 'getMessageContent');
    const replySpy = vi.spyOn(lineService, 'replyMessage').mockResolvedValue();
    await handleWebhookEvents([
      {
        type: 'message',
        replyToken: 'RT-skip',
        source: { userId: 'Unew' },
        timestamp: Date.now(),
        message: { id: 'M-skip', type: 'image' },
      },
    ]);
    const row = await prisma.lineUserMapping.findUnique({
      where: { lineUserId: 'Unew' },
    });
    expect(row?.enabled).toBe(false);
    expect(await prisma.voucher.count()).toBe(0);
    expect(getContentSpy).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalled();
  });

  it('skips disabled user image without creating voucher', async () => {
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'Udis', displayName: 'X', enabled: false },
    });
    const getContentSpy = vi.spyOn(lineService, 'getMessageContent');
    await handleWebhookEvents([
      {
        type: 'message',
        replyToken: 'RT-dis',
        source: { userId: 'Udis' },
        timestamp: Date.now(),
        message: { id: 'M-dis', type: 'image' },
      },
    ]);
    expect(await prisma.voucher.count()).toBe(0);
    expect(getContentSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テスト実行**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-importer.test.ts
```
Expected: 全 8 ケース PASS（既に Task 7 で実装した挙動でカバーされている）。

- [ ] **Step 3: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/tests/services/line-importer.test.ts
git commit -m "test(spec 16): line-importer skip cases (dup messageId, unregistered, disabled)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: line-importer の postback (TDD)

**Files:**
- Modify: `server/src/services/line-importer.ts`
- Modify: `server/tests/services/line-importer.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/line-importer.test.ts` の末尾に追加：

```ts
describe('handleWebhookEvents - postback', () => {
  it('updates Voucher.journalStatus on action=approve', async () => {
    const v = await prisma.voucher.create({
      data: {
        clientId: null,
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        size: 1,
        imageData: Buffer.from([0xff]),
        source: 'line',
        journalStatus: 'drafted',
      },
    });
    const replySpy = vi.spyOn(lineService, 'replyMessage').mockResolvedValue();
    await handleWebhookEvents([
      {
        type: 'postback',
        replyToken: 'RT-pb',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        postback: { data: `voucherId=${v.id}&action=approve` },
      },
    ]);
    const updated = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(updated?.journalStatus).toBe('approved');
    expect(replySpy).toHaveBeenCalled();
  });

  it('updates Voucher.journalStatus on action=rework', async () => {
    const v = await prisma.voucher.create({
      data: {
        clientId: null,
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        size: 1,
        imageData: Buffer.from([0xff]),
        journalStatus: 'drafted',
      },
    });
    vi.spyOn(lineService, 'replyMessage').mockResolvedValue();
    await handleWebhookEvents([
      {
        type: 'postback',
        replyToken: 'RT2',
        source: { userId: 'U1' },
        timestamp: Date.now(),
        postback: { data: `voucherId=${v.id}&action=rework` },
      },
    ]);
    const updated = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(updated?.journalStatus).toBe('rework');
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-importer.test.ts -t postback
```
Expected: FAIL — postback 未実装。

- [ ] **Step 3: postback ハンドリングを追加**

`server/src/services/line-importer.ts` の `handleSingleEvent` 関数末尾、`event.type === 'message'` の処理の後に追加：

```ts
  if (event.type === 'postback' && event.postback) {
    await handlePostback(event);
    return;
  }
```

そして新しい関数を追加（ファイル末尾）：

```ts
async function handlePostback(event: LineEvent): Promise<void> {
  if (!event.postback?.data) return;
  const params = new URLSearchParams(event.postback.data);
  const voucherId = params.get('voucherId');
  const action = params.get('action');
  if (!voucherId || !action) return;

  const v = await prisma.voucher.findUnique({ where: { id: voucherId } });
  if (!v) {
    if (event.replyToken) {
      await lineService
        .replyMessage(event.replyToken, [
          { type: 'text', text: '対象の証憑が見つかりません。' },
        ])
        .catch(() => {});
    }
    return;
  }

  const statusMap: Record<string, string> = {
    approve: 'approved',
    rework: 'rework',
    later: 'pending',
  };
  if (action === 'client') {
    const clientId = params.get('clientId');
    if (clientId) {
      await prisma.voucher.update({
        where: { id: voucherId },
        data: { clientId, matchedClientReason: 'line_postback' },
      });
    }
  } else if (statusMap[action]) {
    await prisma.voucher.update({
      where: { id: voucherId },
      data: { journalStatus: statusMap[action] },
    });
  }

  if (event.replyToken) {
    await lineService
      .replyMessage(event.replyToken, [
        { type: 'text', text: '更新しました。' },
      ])
      .catch(() => {});
  }
}
```

- [ ] **Step 4: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/services/line-importer.test.ts
```
Expected: 全 10 ケース PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/services/line-importer.ts server/tests/services/line-importer.test.ts
git commit -m "feat(spec 16): line-importer handles postback (approve/rework/later/client)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: routes status + verify (TDD)

**Files:**
- Create: `server/src/routes/integrations-line.ts`
- Modify: `server/src/server.ts`
- Create: `server/tests/routes/integrations-line.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/routes/integrations-line.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import * as lineService from '../../src/services/line-service.js';
import { __resetEnvCache } from '../../src/env.js';

const app = await buildApp();

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  await prisma.lineUserMapping.deleteMany();
  vi.restoreAllMocks();
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_SECRET;
  delete process.env.LINE_WEBHOOK_BASE_URL;
  __resetEnvCache();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.lineUserMapping.deleteMany();
  await app.close();
});

describe('GET /api/integrations/line', () => {
  it('returns connected=false when env not set', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/integrations/line' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false });
  });

  it('returns connected=true with userCount when env set', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    process.env.LINE_CHANNEL_SECRET = 'sec';
    process.env.LINE_WEBHOOK_BASE_URL = 'https://bookmee.example.com';
    __resetEnvCache();
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A', enabled: true },
    });
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U2', displayName: 'B', enabled: false },
    });
    const res = await app.inject({ method: 'GET', url: '/api/integrations/line' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(true);
    expect(body.webhookUrl).toBe(
      'https://bookmee.example.com/api/integrations/line/webhook',
    );
    expect(body.userCount).toBe(2);
    expect(body.enabledUserCount).toBe(1);
  });
});

describe('POST /api/integrations/line/verify', () => {
  it('returns ok:true with botInfo when API succeeds', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    process.env.LINE_CHANNEL_SECRET = 'sec';
    __resetEnvCache();
    vi.spyOn(lineService, 'getBotInfo').mockResolvedValue({
      userId: 'Ubot',
      basicId: '@bookmee',
      displayName: 'bookmee bot',
      chatMode: 'bot',
      markAsReadMode: 'auto',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/verify',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.botInfo.basicId).toBe('@bookmee');
  });

  it('returns ok:false when API throws', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    process.env.LINE_CHANNEL_SECRET = 'sec';
    __resetEnvCache();
    vi.spyOn(lineService, 'getBotInfo').mockRejectedValue(
      new Error('getBotInfo failed: 401 ...'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/verify',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain('401');
  });

  it('returns 401 when env not set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/verify',
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/routes/integrations-line.test.ts
```
Expected: FAIL — route 未登録。

- [ ] **Step 3: route 実装（status + verify のみ）**

`server/src/routes/integrations-line.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import * as lineService from '../services/line-service.js';

export async function integrationsLineRoutes(app: FastifyInstance) {
  app.get('/api/integrations/line', async () => {
    const connected = Boolean(
      env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET,
    );
    if (!connected) return { connected: false };
    const [userCount, enabledUserCount] = await Promise.all([
      prisma.lineUserMapping.count(),
      prisma.lineUserMapping.count({ where: { enabled: true } }),
    ]);
    const webhookUrl = env.LINE_WEBHOOK_BASE_URL
      ? `${env.LINE_WEBHOOK_BASE_URL}/api/integrations/line/webhook`
      : null;
    return {
      connected: true,
      channelId: env.LINE_CHANNEL_ID || null,
      webhookUrl,
      userCount,
      enabledUserCount,
    };
  });

  app.post('/api/integrations/line/verify', async (_req, reply) => {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
      reply.code(401);
      return {
        error: {
          code: 'NOT_CONFIGURED',
          message: 'LINE_CHANNEL_ACCESS_TOKEN is not set',
        },
      };
    }
    try {
      const botInfo = await lineService.getBotInfo();
      return { ok: true, botInfo };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
```

- [ ] **Step 4: server.ts に register**

`server/src/server.ts` で `import { voucherRoutes } from './routes/vouchers.js';` の直後に追加：

```ts
import { integrationsLineRoutes } from './routes/integrations-line.js';
```

`await app.register(voucherRoutes);` の直後に追加：

```ts
  await app.register(integrationsLineRoutes);
```

- [ ] **Step 5: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/routes/integrations-line.test.ts
```
Expected: 5 ケース PASS。

- [ ] **Step 6: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/routes/integrations-line.ts server/src/server.ts server/tests/routes/integrations-line.test.ts
git commit -m "feat(spec 16): GET /api/integrations/line + POST /verify endpoints

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: routes webhook (TDD)

**Files:**
- Modify: `server/src/routes/integrations-line.ts`
- Modify: `server/tests/routes/integrations-line.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/routes/integrations-line.test.ts` の末尾に追加：

```ts
import crypto from 'node:crypto';
import * as lineImporter from '../../src/services/line-importer.js';

function signedHeaders(secret: string, body: string): Record<string, string> {
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');
  return {
    'content-type': 'application/json',
    'x-line-signature': sig,
  };
}

describe('POST /api/integrations/line/webhook', () => {
  it('returns 200 and dispatches handleWebhookEvents on valid signature', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    process.env.LINE_CHANNEL_SECRET = 'sec';
    __resetEnvCache();
    const handlerSpy = vi
      .spyOn(lineImporter, 'handleWebhookEvents')
      .mockResolvedValue();
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'message',
          source: { userId: 'U1' },
          timestamp: Date.now(),
          message: { id: 'M1', type: 'text', text: 'hi' },
        },
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/webhook',
      payload: body,
      headers: signedHeaders('sec', body),
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(handlerSpy).toHaveBeenCalledOnce();
    expect(handlerSpy.mock.calls[0][0]).toHaveLength(1);
  });

  it('returns 401 on bad signature', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    process.env.LINE_CHANNEL_SECRET = 'sec';
    __resetEnvCache();
    const handlerSpy = vi.spyOn(lineImporter, 'handleWebhookEvents');
    const body = JSON.stringify({ destination: 'X', events: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/webhook',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-line-signature': 'WRONG',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when secret is not configured', async () => {
    const body = JSON.stringify({ events: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/line/webhook',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-line-signature': 'sig',
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/routes/integrations-line.test.ts -t webhook
```
Expected: FAIL — webhook 未実装。

- [ ] **Step 3: webhook 実装**

`server/src/routes/integrations-line.ts` の先頭の import に追加：

```ts
import { handleWebhookEvents } from '../services/line-importer.js';
import { verifySignature } from '../services/line-service.js';
```

`integrationsLineRoutes` 関数内、`/verify` の後に追加：

```ts
  app.post('/api/integrations/line/webhook', async (req, reply) => {
    if (!env.LINE_CHANNEL_SECRET) {
      reply.code(401);
      return {
        error: { code: 'NOT_CONFIGURED', message: 'channel secret missing' },
      };
    }
    const sig = req.headers['x-line-signature'];
    if (typeof sig !== 'string') {
      reply.code(401);
      return {
        error: { code: 'INVALID_SIGNATURE', message: 'signature header missing' },
      };
    }
    const rawBody = req.rawBody as Buffer | undefined;
    if (!rawBody) {
      reply.code(400);
      return {
        error: { code: 'INVALID_BODY', message: 'raw body unavailable' },
      };
    }
    if (!verifySignature(env.LINE_CHANNEL_SECRET, rawBody, sig)) {
      reply.code(401);
      return {
        error: { code: 'INVALID_SIGNATURE', message: 'signature mismatch' },
      };
    }
    const parsed = JSON.parse(rawBody.toString('utf-8')) as {
      events?: unknown[];
    };
    const events = (parsed.events ?? []) as Parameters<
      typeof handleWebhookEvents
    >[0];
    setImmediate(() => {
      handleWebhookEvents(events).catch(() => {});
    });
    return { ok: true };
  });
```

- [ ] **Step 4: Fastify に raw body 設定**

`server/src/server.ts` の `buildApp` 関数内、`multipart` register の後 / static の前に追加：

```ts
  // LINE webhook needs raw body for signature verification.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (
      req.method === 'POST' &&
      req.url.startsWith('/api/integrations/line/webhook')
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of payload as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      (req as unknown as { rawBody: Buffer }).rawBody = raw;
      // Re-emit so the default JSON parser still works
      const { Readable } = await import('node:stream');
      return Readable.from(raw);
    }
    return payload;
  });
```

注: TypeScript 上の `FastifyRequest` には `rawBody` 型が無いが、ランタイムでは set される。`as unknown as` で回避（既存パターンに合わせる）。

- [ ] **Step 5: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/routes/integrations-line.test.ts
```
Expected: 全 8 ケース PASS。

- [ ] **Step 6: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/routes/integrations-line.ts server/src/server.ts server/tests/routes/integrations-line.test.ts
git commit -m "feat(spec 16): POST /api/integrations/line/webhook with HMAC verification

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: routes users mapping CRUD (TDD)

**Files:**
- Modify: `server/src/routes/integrations-line.ts`
- Modify: `server/tests/routes/integrations-line.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/routes/integrations-line.test.ts` の末尾に追加：

```ts
describe('users mapping endpoints', () => {
  it('GET /users returns rows', async () => {
    await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/line/users',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('PATCH /users/:id updates staffLabel + enabled', async () => {
    const row = await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/integrations/line/users/${row.id}`,
      payload: { staffLabel: '所長', enabled: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.lineUserMapping.findUnique({
      where: { id: row.id },
    });
    expect(updated?.staffLabel).toBe('所長');
    expect(updated?.enabled).toBe(true);
  });

  it('DELETE /users/:id removes row', async () => {
    const row = await prisma.lineUserMapping.create({
      data: { lineUserId: 'U1', displayName: 'A' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/line/users/${row.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.lineUserMapping.count()).toBe(0);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/routes/integrations-line.test.ts -t users
```
Expected: 3 ケース FAIL。

- [ ] **Step 3: route 追加**

`server/src/routes/integrations-line.ts` の `integrationsLineRoutes` 関数末尾に追加：

```ts
  app.get('/api/integrations/line/users', async () => {
    return prisma.lineUserMapping.findMany({ orderBy: { createdAt: 'asc' } });
  });

  app.patch<{
    Params: { id: string };
    Body: { staffLabel?: string | null; enabled?: boolean };
  }>('/api/integrations/line/users/:id', async (req, reply) => {
    const data: Record<string, unknown> = {};
    if (req.body.staffLabel !== undefined) data.staffLabel = req.body.staffLabel;
    if (req.body.enabled !== undefined) data.enabled = req.body.enabled;
    const r = await prisma.lineUserMapping.updateMany({
      where: { id: req.params.id },
      data,
    });
    if (r.count === 0) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'user not found' } };
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/integrations/line/users/:id',
    async (req, reply) => {
      const r = await prisma.lineUserMapping.deleteMany({
        where: { id: req.params.id },
      });
      if (r.count === 0) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'user not found' } };
      }
      return { ok: true };
    },
  );
```

- [ ] **Step 4: テストパス**

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run tests/routes/integrations-line.test.ts
```
Expected: 全 11 ケース PASS。

- [ ] **Step 5: 全テスト走らせて確認**

```bash
cd /home/kkouta/poc/bookmee/server && npm test 2>&1 | tail -5
```
Expected: 全テスト PASS。

- [ ] **Step 6: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/routes/integrations-line.ts server/tests/routes/integrations-line.test.ts
git commit -m "feat(spec 16): users mapping CRUD endpoints (GET / PATCH / DELETE)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: voucher-service に LINE Push フック追加

**Files:**
- Modify: `server/src/services/voucher-service.ts`

- [ ] **Step 1: import 追加**

`server/src/services/voucher-service.ts` の既存 import 群に追加：

```ts
import * as lineService from './line-service.js';
```

- [ ] **Step 2: assignAndMatchVoucher の末尾にフック追加**

`server/src/services/voucher-service.ts` の `assignAndMatchVoucher` 関数の **最後の `}` の直前** に追加（既存の generateDraftJournal 呼び出しと outreach のさらに後）：

```ts
  // Spec 16: LINE 由来の Voucher なら、結果をスタッフに Push API + Quick Reply で通知
  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    const final = await prisma.voucher.findUnique({
      where: { id },
      select: {
        source: true,
        lineUserId: true,
        ocrStatus: true,
        matchStatus: true,
        journalStatus: true,
        draftJournalJson: true,
      },
    });
    if (final?.source === 'line' && final.lineUserId) {
      try {
        await maybePushLineFollowup(final.lineUserId, id, final);
      } catch (err) {
        // best-effort, don't fail the matching flow
      }
    }
  }
```

そして関数の定義の **下**（同ファイル内、他関数の下）に追加：

```ts
async function maybePushLineFollowup(
  lineUserId: string,
  voucherId: string,
  v: {
    ocrStatus: string;
    matchStatus: string;
    journalStatus: string;
    draftJournalJson: unknown;
  },
): Promise<void> {
  if (v.ocrStatus === 'failed') {
    await lineService.pushMessage(lineUserId, [
      {
        type: 'text',
        text: '画像の読み取りに失敗しました。撮り直してお送りください。',
      },
    ]);
    return;
  }
  if (v.journalStatus === 'drafted') {
    const draft = (v.draftJournalJson as
      | { account?: string; amount?: number }
      | null) ?? {};
    const summary = `${draft.account ?? '勘定不明'} ¥${draft.amount ?? '不明'} で計上しました。よろしいですか？`;
    await lineService.pushQuickReply(lineUserId, summary, [
      { label: '✅ OK', data: `voucherId=${voucherId}&action=approve` },
      { label: '🔄 直す', data: `voucherId=${voucherId}&action=rework` },
      { label: '❓ あとで', data: `voucherId=${voucherId}&action=later` },
    ]);
    return;
  }
  if (v.matchStatus === 'matched') {
    await lineService.pushMessage(lineUserId, [
      { type: 'text', text: '既存の仕訳に紐付けました。' },
    ]);
  }
}
```

- [ ] **Step 3: 既存テストが壊れていないことを確認**

```bash
cd /home/kkouta/poc/bookmee/server && npm test 2>&1 | tail -5
```
Expected: 全テスト PASS。voucher-service の既存テストは LINE 環境変数が空なのでフックは発火せず、挙動が変わらない。

- [ ] **Step 4: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add server/src/services/voucher-service.ts
git commit -m "feat(spec 16): voucher-service pushes LINE Quick Reply when source=line

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: フロントエンド ナビ + 接続パネル

**Files:**
- Modify: `index.html`
- Modify: `script.js`
- Modify: `styles.css`

- [ ] **Step 1: 左ナビにリンク追加**

`index.html` を Read し、既存の `data-view="..."` のナビリンクが並んでいる箇所に、適切な位置（「証憑登録」関連の近く、または末尾）に追加：

```html
<a href="#" class="nav-link" data-view="integrations-line">連携 / LINE</a>
```

- [ ] **Step 2: ビューコンテナを追加**

`index.html` の `<section data-view="...">` が並ぶ箇所に追加：

```html
<section data-view="integrations-line" hidden>
  <div class="integration-line-connection"></div>
  <div class="line-user-mappings"></div>
</section>
```

- [ ] **Step 3: CSS 追加**

`styles.css` 末尾に追加：

```css
.integration-line-connection,
.line-user-mappings {
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.line-user-row {
  display: grid;
  grid-template-columns: 1fr 180px 100px auto;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f3f4f6;
}
.voucher-source-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
}
.voucher-source-badge.line { background: #06c755; }
.voucher-source-badge.drive { background: #1a73e8; }
.voucher-caption {
  font-size: 11px;
  color: #555;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 4px;
}
```

- [ ] **Step 4: appState 拡張**

`script.js` 内の `const appState = {` ブロックに以下を追加（既存キーの末尾付近）：

```js
  lineIntegration: null,
  lineUsers: [],
  lineVerifyResult: null,
```

- [ ] **Step 5: renderView ルーティング追加 + 接続パネル本体**

`script.js` 内の `renderView` (object or switch) に追加：

```js
  "integrations-line": () => renderIntegrationsLine(),
```

そして以下の関数を追加（既存の他 render 関数の近くに）：

```js
async function renderIntegrationsLine() {
  const container = document.querySelector('section[data-view="integrations-line"]');
  if (!container) return;
  await loadLineIntegration();
  await loadLineUsers();

  const conn = container.querySelector('.integration-line-connection');
  const integ = appState.lineIntegration;
  if (!integ || !integ.connected) {
    conn.innerHTML =
      '<h2>LINE 公式アカウント連携</h2>' +
      '<p>未接続です。<code>.env</code> に <code>LINE_CHANNEL_ACCESS_TOKEN</code> / <code>LINE_CHANNEL_SECRET</code> を設定してください。</p>';
  } else {
    const webhook = integ.webhookUrl ?? '(LINE_WEBHOOK_BASE_URL 未設定)';
    const verifyHtml = appState.lineVerifyResult
      ? appState.lineVerifyResult.ok
        ? `<p style="color:#06c755;">✓ 接続テスト成功: ${escapeHtmlTextLine(appState.lineVerifyResult.botInfo?.displayName ?? '')} (${escapeHtmlTextLine(appState.lineVerifyResult.botInfo?.basicId ?? '')})</p>`
        : `<p style="color:#c00;">✗ ${escapeHtmlTextLine(appState.lineVerifyResult.message ?? '')}</p>`
      : '';
    conn.innerHTML =
      '<h2>LINE 公式アカウント連携</h2>' +
      `<p>状態: 接続済 (channelId: ${escapeHtmlTextLine(integ.channelId ?? '-')}, ユーザ ${integ.enabledUserCount}/${integ.userCount} 有効)</p>` +
      `<p>Webhook URL: <code id="line-webhook-url">${escapeHtmlTextLine(webhook)}</code> <button id="line-copy-webhook">コピー</button></p>` +
      '<button id="line-verify" class="btn btn-primary">接続テスト</button>' +
      verifyHtml +
      '<h3>Console 設定手順</h3>' +
      '<ol>' +
        '<li>LINE Developers Console で Messaging API channel の "Webhook URL" に上記 URL をペースト</li>' +
        '<li>"Use webhook" を ON</li>' +
        '<li>"Auto-reply messages" を OFF</li>' +
        '<li>友だち追加用の Basic ID / QR をスタッフに共有</li>' +
      '</ol>';
    document.getElementById('line-copy-webhook')?.addEventListener('click', () => {
      navigator.clipboard.writeText(webhook).catch(() => {});
    });
    document.getElementById('line-verify')?.addEventListener('click', verifyLineConnection);
  }
}

function escapeHtmlTextLine(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadLineIntegration() {
  const res = await fetch('/api/integrations/line');
  appState.lineIntegration = await res.json();
}

async function loadLineUsers() {
  const res = await fetch('/api/integrations/line/users');
  appState.lineUsers = res.ok ? await res.json() : [];
}

async function verifyLineConnection() {
  const res = await fetch('/api/integrations/line/verify', { method: 'POST' });
  appState.lineVerifyResult = await res.json();
  renderIntegrationsLine();
}
```

- [ ] **Step 6: 手動確認**

```bash
cd /home/kkouta/poc/bookmee/server && npm run dev
```
別ターミナルでブラウザで `http://localhost:3000` を開き、左ナビ「連携 / LINE」をクリック。`.env` に LINE_* が設定されていれば「接続済」と webhook URL が出る。

- [ ] **Step 7: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add index.html script.js styles.css
git commit -m "feat(spec 16): frontend integrations-line view with connection + verify panel

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 15: フロント users mapping パネル

**Files:**
- Modify: `script.js`

- [ ] **Step 1: users mapping パネルを実装**

`script.js` の `renderIntegrationsLine` の接続済ブロック末尾に追加（`document.getElementById('line-verify')?.addEventListener` の後）：

```js
    const usersPane = container.querySelector('.line-user-mappings');
    if (appState.lineUsers.length === 0) {
      usersPane.innerHTML =
        '<h2>スタッフ一覧</h2>' +
        '<p>友だち追加されると自動で行が追加されます（最初は無効状態）。所長が承認するまで画像は受け付けられません。</p>';
    } else {
      usersPane.innerHTML =
        '<h2>スタッフ一覧</h2>' +
        appState.lineUsers
          .map(
            (u) =>
              `<div class="line-user-row" data-user-id="${escapeHtmlTextLine(u.id)}">` +
              `<span>${escapeHtmlTextLine(u.displayName)} <small style="color:#888">${escapeHtmlTextLine(u.lineUserId)}</small></span>` +
              `<input type="text" class="line-user-label" placeholder="ラベル (例: 所長)" value="${escapeHtmlTextLine(u.staffLabel ?? '')}">` +
              `<label><input type="checkbox" class="line-user-enabled" ${u.enabled ? 'checked' : ''}> 有効</label>` +
              `<button class="line-user-delete">削除</button>` +
              `</div>`,
          )
          .join('');
      usersPane.querySelectorAll('.line-user-row').forEach((row) => {
        const userId = row.dataset.userId;
        row.querySelector('.line-user-label')?.addEventListener('change', (e) => {
          updateLineUser(userId, { staffLabel: e.target.value });
        });
        row.querySelector('.line-user-enabled')?.addEventListener('change', (e) => {
          updateLineUser(userId, { enabled: e.target.checked });
        });
        row.querySelector('.line-user-delete')?.addEventListener('click', () => {
          deleteLineUser(userId);
        });
      });
    }
```

そしてヘルパ関数を追加：

```js
async function updateLineUser(id, body) {
  await fetch(`/api/integrations/line/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  renderIntegrationsLine();
}

async function deleteLineUser(id) {
  if (!confirm('このユーザを削除します')) return;
  await fetch(`/api/integrations/line/users/${id}`, { method: 'DELETE' });
  renderIntegrationsLine();
}
```

- [ ] **Step 2: 手動確認**

ブラウザで「連携 / LINE」を再読込。空状態のメッセージが出る。`prisma studio` で `LineUserMapping` 行を追加してリロードすると行が表示される。ラベル編集 / 有効化トグル / 削除ボタンが動くことを確認。

- [ ] **Step 3: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add script.js
git commit -m "feat(spec 16): frontend users mapping UI for LINE integration

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 16: 証憑登録ビューに source/caption バッジを追加

**Files:**
- Modify: `script.js`

- [ ] **Step 1: 既存の voucher サムネ描画箇所を確認**

`script.js` で「voucher」のサムネカードを組み立てている関数を grep で見つけ（`renderVoucherRegister` か `loadVouchers` 周辺、card の HTML 文字列を組み立てている部分）、画像の `<img>` を含む親要素に以下を追加する。

`<img src="/api/vouchers/${voucher.id}/image">` の前後で、カード div の中に：

```js
const sourceLabelMap = { line: 'LINE', drive: 'Drive', manual: '手動' };
const sourceClass = voucher.source ?? 'manual';
const sourceBadge = `<span class="voucher-source-badge ${sourceClass}">${sourceLabelMap[sourceClass] ?? '手動'}</span>`;
const captionHtml = voucher.caption
  ? `<div class="voucher-caption" title="${escapeHtmlTextLine(voucher.caption)}">${escapeHtmlTextLine(voucher.caption)}</div>`
  : '';
```

そして card の HTML 文字列内に `${sourceBadge}`（画像の overlay として）と `${captionHtml}`（カード下部）を埋め込む。card の親 div の style に `position: relative;` が無ければ追加（または CSS の該当クラスに追加）。

正確な編集箇所は `script.js` の既存実装に依存するので、subagent は実装時に：
- voucher サムネ生成ロジックを grep で特定
- 上記 sourceBadge / captionHtml を組み込む
- 親 div の `position: relative` を確保

- [ ] **Step 2: 手動確認**

`prisma studio` で `Voucher` の `source` を `'line'` に変えた行を作る、または LINE 経由で実際に取り込んでサムネのバッジ表示を確認。

- [ ] **Step 3: Commit**

```bash
cd /home/kkouta/poc/bookmee && git add script.js
git commit -m "feat(spec 16): show source badge + caption on voucher thumbnails

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 17: 接続テスト（最終確認）

**Files:** なし（手動 + curl）

- [ ] **Step 1: サーバ起動**

```bash
cd /home/kkouta/poc/bookmee/server && npm run dev
```

- [ ] **Step 2: env 検証**

別ターミナルで:
```bash
curl -s http://localhost:3000/api/integrations/line | jq
```
Expected: `connected: true`、`channelId`、`webhookUrl`（または null）。

- [ ] **Step 3: LINE API 疎通確認**

```bash
curl -s -X POST http://localhost:3000/api/integrations/line/verify | jq
```
Expected: `ok: true`、`botInfo` に `userId` / `basicId` / `displayName` が入る。`ok: false` の場合は `.env` の `LINE_CHANNEL_ACCESS_TOKEN` を再確認。

- [ ] **Step 4: 結果を報告**

報告内容:
- `/api/integrations/line` の JSON
- `/api/integrations/line/verify` の JSON
- 全自動テストの最終結果 (`cd /home/kkouta/poc/bookmee/server && npm test 2>&1 | tail -5`)

---

## Self-Review Checklist

実装完了時点で spec 16 の受入基準に対応するタスクを確認：

- [ ] **Prisma migrate で LineUserMapping + Voucher 4 列** → Task 1
- [ ] **env に LINE_* を設定して /api/integrations/line が connected:true** → Task 2 + Task 10
- [ ] **POST /verify で LINE API に疎通** → Task 10 + Task 17
- [ ] **friend 追加で auto-create + welcome reply** → Task 6
- [ ] **enabled=true に変更 → 画像送信で Voucher 作成** → Task 7 + Task 12
- [ ] **caption が紐付く** → Task 7
- [ ] **同 messageId 再送で二重作成されない** → Task 8
- [ ] **OCR / 突合完了時に Push + Quick Reply** → Task 13
- [ ] **Quick Reply ボタンで journalStatus 更新** → Task 9
- [ ] **サーバテスト 16 ケース** → Task 3 (4) + Task 5 (5) + Task 6 (2) + Task 7 (3) + Task 8 (3) + Task 9 (2) + Task 10 (5) + Task 11 (3) + Task 12 (3) = 30 ケース（spec の最低 16 を大幅超過）
- [ ] **フロント疎通** → Task 14-16

---

## Execution Notes

- 既存方針（vitest + 実 Postgres、`vi.spyOn` で external API モック）を踏襲
- フロントテスト基盤は無いので Task 14-16 は手動確認
- raw body 取得は `preParsing` フックで一括対応（webhook ルートだけ）
- LINE WORKS コード（`notification.ts:114-200` 付近の `sendLineWorksMessage` / `getLineWorksToken`）の削除は spec 17 で実施
- ngrok 等で公開 HTTPS を当てれば実 LINE Console から webhook 検証が走る（本プランの範囲では env 設定 + verify endpoint まで）
