# Spec 12: 証憑 × MF 仕訳 突合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** OCR 済み Voucher を顧問先に AI 推測で振り分け、その顧問先の MF 仕訳と金額完全一致 + 日付 ±30日 で突合する。突合バッジを UI に出す。

**Architecture:**
- `voucher-assign-service.ts`: addressee 部分一致 → fallback で OpenAI に問い合わせ → clientId を返す
- `matching-service.ts`: 顧問先の MF 仕訳を live fetch → 金額一致 + 日付 ±30日 → 最近接の 1 件
- `voucher-service.assignAndMatchVoucher`: assign → match のランナー
- `runOcrForVoucher` の done 遷移直後に setImmediate でキック
- フロントは突合バッジ + タブ間 D&D で手動再割当て

**Tech Stack:** OpenAI SDK / Prisma migration / Vitest / Vanilla JS

**Spec source:** `docs/superpowers/specs/2026-05-19-12-voucher-matching-design.md`

---

## Task 1: Voucher.matchedAt + matchedClientReason 追加 + migration

**Files:** `server/prisma/schema.prisma`

- [ ] **Step 1: schema.prisma に追加**

`Voucher` モデル内の `matchStatus` の下に追加:

```prisma
  matchedAt           DateTime?
  matchedClientReason String?
```

- [ ] **Step 2: migrate**

```bash
cd /home/kkouta/poc/bookmee/server
npx prisma migrate dev --name add-voucher-match-meta
```

- [ ] **Step 3: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat(spec 12): add Voucher.matchedAt and matchedClientReason"
```

---

## Task 2: matching-service.ts (TDD)

**Files:** `server/src/services/matching-service.ts`, `server/tests/services/matching-service.test.ts`

`findMatchForVoucher(voucherId)` を実装。getLiveMfEntries は `vi.spyOn` で固定 RawEntry[] を返させる。

ケース:
1. `clientId が null → status='no_client'`
2. `ocrJson が null または amount null → status='no_data'`
3. `entries 0 件 → status='unmatched'`
4. `金額一致 + 日付 ±30 内に 1 件 → status='matched', matchedEntryId=sourceEntryId`
5. `複数候補 → 日付差最小を選ぶ`
6. `金額一致でも日付 31日超 → unmatched`

実装:

```ts
import { prisma } from '../lib/prisma.js';
import { getLiveMfEntries } from './client-service.js';
import type { RawEntry } from '../adapters/vendor-adapter.js';

export type MatchStatus = 'matched' | 'unmatched' | 'no_client' | 'no_data';

export interface MatchResult {
  status: MatchStatus;
  matchedEntryId: string | null;
}

export async function findMatchForVoucher(
  voucherId: string,
): Promise<MatchResult> {
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { clientId: true, ocrJson: true },
  });
  if (!v) return { status: 'unmatched', matchedEntryId: null };
  if (!v.clientId) return { status: 'no_client', matchedEntryId: null };
  const j = (v.ocrJson as { amount?: number | null; issue_date?: string | null } | null) ?? null;
  if (!j || j.amount == null || !j.issue_date) {
    return { status: 'no_data', matchedEntryId: null };
  }
  const entries = await getLiveMfEntries(v.clientId);
  const voucherDate = new Date(j.issue_date);
  const candidates = entries
    .filter((e) => e.amount === j.amount)
    .map((e) => ({
      entry: e,
      dayDiff: Math.abs(
        Math.round((e.occurredAt.getTime() - voucherDate.getTime()) / 86400000),
      ),
    }))
    .filter((c) => c.dayDiff <= 30)
    .sort((a, b) => a.dayDiff - b.dayDiff);
  if (candidates.length === 0) {
    return { status: 'unmatched', matchedEntryId: null };
  }
  return {
    status: 'matched',
    matchedEntryId: candidates[0].entry.sourceEntryId,
  };
}
```

各ケースのテストファイル雛形:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { createVoucher } from '../../src/services/voucher-service.js';
import { findMatchForVoucher } from '../../src/services/matching-service.js';
import * as clientService from '../../src/services/client-service.js';

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.$disconnect();
});

async function makeVoucher(ocrJson: unknown, clientId: string | null = null) {
  const meta = await createVoucher({
    clientId,
    filename: 't.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff]),
    uploadedBy: null,
  });
  await prisma.voucher.update({
    where: { id: meta.id },
    data: { ocrJson: ocrJson as any, ocrStatus: 'done' },
  });
  return meta.id;
}

function entry(id: string, amount: number, date: string) {
  return {
    sourceEntryId: id,
    account: '雑費',
    description: 'x',
    amount,
    occurredAt: new Date(date),
  } as any;
}

describe('findMatchForVoucher', () => {
  it('returns no_client when clientId is null', async () => {
    const id = await makeVoucher({ amount: 100, issue_date: '2026-05-15' });
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'no_client',
      matchedEntryId: null,
    });
  });

  it('returns no_data when ocrJson is missing fields', async () => {
    const id = await makeVoucher({ amount: null, issue_date: null }, 'aoyama-design');
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'no_data',
      matchedEntryId: null,
    });
  });

  it('returns unmatched when MF returns no entries', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([]);
    const id = await makeVoucher({ amount: 100, issue_date: '2026-05-15' }, 'aoyama-design');
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'unmatched',
      matchedEntryId: null,
    });
  });

  it('returns matched on amount+date match', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([
      entry('E1', 100, '2026-05-17'),
    ]);
    const id = await makeVoucher({ amount: 100, issue_date: '2026-05-15' }, 'aoyama-design');
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'matched',
      matchedEntryId: 'E1',
    });
  });

  it('picks closest date when multiple candidates', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([
      entry('E1', 100, '2026-05-01'),
      entry('E2', 100, '2026-05-16'),
      entry('E3', 100, '2026-05-25'),
    ]);
    const id = await makeVoucher({ amount: 100, issue_date: '2026-05-15' }, 'aoyama-design');
    const result = await findMatchForVoucher(id);
    expect(result.status).toBe('matched');
    expect(result.matchedEntryId).toBe('E2'); // 1 日差で最近接
  });

  it('returns unmatched when amount matches but date >30 days', async () => {
    vi.spyOn(clientService, 'getLiveMfEntries').mockResolvedValue([
      entry('E1', 100, '2026-07-01'), // 47 日差
    ]);
    const id = await makeVoucher({ amount: 100, issue_date: '2026-05-15' }, 'aoyama-design');
    expect(await findMatchForVoucher(id)).toEqual({
      status: 'unmatched',
      matchedEntryId: null,
    });
  });
});
```

---

## Task 3: voucher-assign-service.ts (TDD)

**Files:** `server/src/services/voucher-assign-service.ts`, `server/tests/services/voucher-assign-service.test.ts`

`assignVoucherToClient(voucherId)` を実装。3 ケース:
1. addressee に顧問先名が部分一致 → reason='addressee'
2. 部分一致なし、OpenAI が clientId 返す → reason='ai'
3. 部分一致なし、OpenAI が null 返す → clientId=null, reason='ai_uncertain'

実装スケッチ:

```ts
import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

const AiResponseSchema = z.object({
  clientId: z.string().nullable(),
});

export interface AssignResult {
  clientId: string | null;
  reason: string;
}

export async function assignVoucherToClient(
  voucherId: string,
): Promise<AssignResult> {
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { ocrJson: true },
  });
  if (!v || !v.ocrJson) return { clientId: null, reason: 'no_data' };
  const j = v.ocrJson as { addressee?: string | null; vendor_name?: string | null };
  const clients = await prisma.client.findMany({ select: { id: true, name: true, industry: true } });

  // 1. addressee の部分一致
  if (j.addressee && j.addressee.length >= 3) {
    const hit = clients.find(
      (c) =>
        c.name.length >= 3 &&
        (j.addressee!.includes(c.name) || c.name.includes(j.addressee!)),
    );
    if (hit) return { clientId: hit.id, reason: 'addressee' };
  }

  // 2. OpenAI 推測
  if (!env.OPENAI_API_KEY) return { clientId: null, reason: 'no_api_key' };
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const prompt = `領収書の情報:
発行者: ${j.vendor_name ?? '(不明)'}
宛名: ${j.addressee ?? '(不明)'}

顧問先一覧:
${clients.map((c) => `- ${c.id}: ${c.name} (${c.industry})`).join('\n')}

この領収書を経費として計上する可能性が最も高い顧問先を 1 つ選んでください。判断できなければ null を返してください。`;
  const completion = await client.chat.completions.create({
    model: env.OPENAI_VISION_MODEL,
    messages: [
      { role: 'system', content: 'JSON でのみ回答してください。' },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'client_assignment',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { clientId: { type: ['string', 'null'] } },
          required: ['clientId'],
        },
      },
    },
  });
  const text = completion.choices[0]?.message?.content ?? '{}';
  const parsed = AiResponseSchema.parse(JSON.parse(text));
  if (parsed.clientId && clients.find((c) => c.id === parsed.clientId)) {
    return { clientId: parsed.clientId, reason: 'ai' };
  }
  return { clientId: null, reason: 'ai_uncertain' };
}
```

テストは `vi.mock('openai')` パターンを ocr-service.test.ts を参考に。

---

## Task 4: assignAndMatchVoucher runner + runOcrForVoucher 連携

**Files:** `server/src/services/voucher-service.ts`, `server/tests/services/voucher-service.test.ts`

```ts
export async function assignAndMatchVoucher(voucherId: string): Promise<void> {
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { clientId: true, ocrStatus: true },
  });
  if (!v || v.ocrStatus !== 'done') return;

  let assignedClientId = v.clientId;
  let reason: string | null = v.clientId ? 'manual' : null;
  if (!v.clientId) {
    const assigned = await assignVoucherToClient(voucherId);
    if (assigned.clientId) {
      await prisma.voucher.update({
        where: { id: voucherId },
        data: { clientId: assigned.clientId, matchedClientReason: assigned.reason },
      });
      assignedClientId = assigned.clientId;
      reason = assigned.reason;
    }
  }

  const match = await findMatchForVoucher(voucherId);
  await prisma.voucher.update({
    where: { id: voucherId },
    data: {
      matchStatus: match.status,
      matchedEntryId: match.matchedEntryId,
      matchedAt: new Date(),
      ...(reason ? { matchedClientReason: reason } : {}),
    },
  });
}
```

`runOcrForVoucher` の done 遷移後に追加:

```ts
    if (env.OPENAI_API_KEY) {
      setImmediate(() => {
        assignAndMatchVoucher(id).catch(() => {});
      });
    }
```

(`env` import 追加が必要)

テスト 3 ケース追加:
1. clientId 未割当て + OpenAI スパイで AI 推測ヒット → clientId と matchStatus が更新される
2. clientId 既設定 + getLiveMfEntries スパイ → matched
3. ocrStatus が done でない → no-op

---

## Task 5: PATCH /api/vouchers/:id ルート (TDD)

**Files:** `server/src/routes/vouchers.ts`, `server/tests/routes/vouchers.test.ts`

```ts
app.patch<{
  Params: { id: string };
  Body: { clientId?: string | null };
}>('/api/vouchers/:id', async (req, reply) => {
  const row = await prisma.voucher.findUnique({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (!row) {
    reply.code(404);
    return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
  }
  const newClientId = req.body?.clientId ?? null;
  await prisma.voucher.update({
    where: { id: req.params.id },
    data: { clientId: newClientId, matchedClientReason: 'manual' },
  });
  setImmediate(() => {
    findMatchForVoucher(req.params.id)
      .then(async (m) => {
        await prisma.voucher.update({
          where: { id: req.params.id },
          data: {
            matchStatus: m.status,
            matchedEntryId: m.matchedEntryId,
            matchedAt: new Date(),
          },
        });
      })
      .catch(() => {});
  });
  return { ok: true };
});
```

テスト 3 ケース:
1. 存在する voucher の clientId を null → 'aoyama-design' に更新 → 200 + 後で matchStatus が更新（spy で確認）
2. 存在する voucher の clientId を 'aoyama-design' → null に更新 → 200 + matchStatus='no_client'
3. 存在しない id → 404

---

## Task 6: POST /api/vouchers/:id/match (TDD)

**Files:** 同上

```ts
app.post<{ Params: { id: string } }>(
  '/api/vouchers/:id/match',
  async (req, reply) => {
    const row = await prisma.voucher.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!row) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'voucher not found' } };
    }
    setImmediate(() => {
      findMatchForVoucher(req.params.id)
        .then(async (m) => {
          await prisma.voucher.update({
            where: { id: req.params.id },
            data: {
              matchStatus: m.status,
              matchedEntryId: m.matchedEntryId,
              matchedAt: new Date(),
            },
          });
        })
        .catch(() => {});
    });
    reply.code(202);
    return { ok: true };
  },
);
```

テスト 2 ケース（202 + 404）

---

## Task 7: GET /api/vouchers レスポンス拡張 — matchedAt / matchedClientReason 追加

**Files:** `server/src/services/voucher-service.ts`, `server/tests/services/voucher-service.test.ts`

`VoucherMeta` interface に追加:

```ts
  matchedEntryId: string | null;
  matchedAt: Date | null;
  matchedClientReason: string | null;
```

`toMeta` 更新、`listVouchers` の select に追加。

NOTE: `matchedEntry` (embedded entry) は live fetch 高コストなので、本タスクでは含めない。フロントは voucher.clientId + matchedEntryId を見て、必要なら別途取得（spec 13 範囲）。

テスト 1 ケース追加。

---

## Task 8: フロント — 突合バッジをカードに追加

**Files:** `script.js`

`renderVoucherRegister` の card 生成内、ocrHtml の直後に matchHtml 追加:

```js
let matchHtml = '';
const ms = v.matchStatus;
if (ms === 'matched') {
  matchHtml = `<div class="voucher-match match-ok">🔗 ✓ MF 仕訳と突合済み</div>`;
} else if (ms === 'unmatched' && ocr === 'done') {
  matchHtml = `<div class="voucher-match match-no"><span>🔗 MF 仕訳と一致なし</span><button class="voucher-match-retry" data-voucher-rematch="${v.id}">再突合</button></div>`;
} else if (ms === 'no_client') {
  matchHtml = `<div class="voucher-match match-gray">🔗 顧問先未割当て</div>`;
} else if (ms === 'no_data') {
  matchHtml = `<div class="voucher-match match-gray">🔗 OCR データ不足</div>`;
}
```

`renderView` の vouchers-register ブロック内に rematch ボタン handler を追加:

```js
viewContent.querySelectorAll('[data-voucher-rematch]').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.dataset.voucherRematch;
    try {
      const res = await fetch(`/api/vouchers/${id}/match`, { method: 'POST' });
      if (!res.ok) throw new Error('rematch failed');
      appState.vouchersLoadedTab = null;
      await loadVouchers();
    } catch (err) {
      showToast(friendlyError(err));
    }
  });
});
```

ポーリング条件も拡張: matchStatus が `null` か空（突合未実行）の場合もポーリング継続。

---

## Task 9: フロント — タブ間 D&D で顧問先再割当て

**Files:** `script.js`

カード自体を `draggable="true"` に、タブを drop target に。

`renderVoucherRegister` の voucher-card div に `draggable="true"` を付ける。

`renderView` の vouchers-register ブロックに追加:

```js
viewContent.querySelectorAll('.voucher-card').forEach((card) => {
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', card.dataset.voucherId);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });
});
viewContent.querySelectorAll('.voucher-tab').forEach((tab) => {
  tab.addEventListener('dragover', (e) => {
    e.preventDefault();
    tab.classList.add('drop-target');
  });
  tab.addEventListener('dragleave', () => {
    tab.classList.remove('drop-target');
  });
  tab.addEventListener('drop', async (e) => {
    e.preventDefault();
    tab.classList.remove('drop-target');
    const voucherId = e.dataTransfer.getData('text/plain');
    if (!voucherId) return;
    const targetTab = tab.dataset.voucherTab;
    const newClientId = targetTab === 'unassigned' ? null : targetTab;
    try {
      const res = await fetch(`/api/vouchers/${voucherId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: newClientId }),
      });
      if (!res.ok) throw new Error('reassign failed');
      appState.vouchersLoadedTab = null;
      await loadVouchers();
    } catch (err) {
      showToast(friendlyError(err));
    }
  });
});
```

---

## Task 10: styles.css — 突合バッジ + D&D

```css
.voucher-match {
  padding: 4px 8px;
  font-size: 11px;
  border-top: 1px solid #f3f4f6;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.voucher-match.match-ok { background: #ecfdf5; color: #047857; }
.voucher-match.match-no { background: #fefce8; color: #a16207; }
.voucher-match.match-gray { background: #f9fafb; color: #6b7280; }
.voucher-match-retry {
  background: #a16207; color: #fff; border: 0; border-radius: 4px;
  padding: 2px 8px; cursor: pointer; font-size: 10px;
}
.voucher-card.dragging { opacity: 0.4; }
.voucher-tab.drop-target {
  background: #eef2ff; border-bottom-color: #6366f1 !important;
}
```

---

## Task 11: 手動 UI 検証

- [ ] 新規アップロード → 数秒後にカードに OCR + 突合 が両方表示される
- [ ] addressee が顧問先名と一致しないケースで AI 推測が走る
- [ ] サムネをタブにドラッグ → 別顧問先に振り分け + 再突合
- [ ] 「MF と一致なし」で「再突合」ボタンを押すと再実行

---

## Task 12: 全体回帰

```bash
cd /home/kkouta/poc/bookmee/server && npx vitest run
```
