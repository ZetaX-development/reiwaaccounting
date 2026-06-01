# 証憑インバウンド通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LINE / Google Drive から投入された証憑を、Webアプリ利用者にトーストで通知する（15秒ポーリング＋再訪時の集約表示）。

**Architecture:** バックエンドに集計エンドポイント `GET /api/vouchers/inbound-since` を1本追加。フロントは localStorage に「最後に確認したサーバ時刻」を保持し、起動時＋15秒ポーリングで差分を取得して `showToast` で表示する。スキーマ変更なし。

**Tech Stack:** Fastify + Prisma (groupBy) + Vanilla JS。テストは vitest（実Postgres、モックなし）。

参照スペック: `docs/superpowers/specs/2026-06-02-27-inbound-voucher-notifications-design.md`

---

## File Structure

- `server/src/services/voucher-service.ts`（**Modify**）— 集計関数 `countInboundSince` を追加
- `server/src/routes/vouchers.ts`（**Modify**）— `GET /api/vouchers/inbound-since` ルートを追加（`voucherRoutes` は `server.ts` で登録済みなので server.ts の変更は不要）
- `server/tests/routes/vouchers-inbound-since.test.ts`（**Create**）— ルートのテスト
- `script.js`（**Modify**）— ポーリング＋トースト＋ブート配線

---

## Task 1: バックエンド集計エンドポイント

**Files:**
- Modify: `server/src/services/voucher-service.ts`
- Modify: `server/src/routes/vouchers.ts`
- Test: `server/tests/routes/vouchers-inbound-since.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `server/tests/routes/vouchers-inbound-since.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { authHeaders } from '../helpers/auth.js';

const app = await buildApp();
const auth = await authHeaders();

const OTHER_FIRM = 'inbound-other-firm';

// demo-firm 配下に、source と createdAt を制御した証憑を作る
async function makeVoucher(opts: {
  firmId: string;
  source: string;
  createdAt: Date;
}) {
  return prisma.voucher.create({
    data: {
      firmId: opts.firmId,
      source: opts.source,
      createdAt: opts.createdAt,
      filename: 'x.png',
      mimeType: 'image/png',
      size: 3,
      imageData: Buffer.from([0x89, 0x50, 0x4e]),
    },
  });
}

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await prisma.firm.create({
    data: { id: OTHER_FIRM, name: 'Other', slug: OTHER_FIRM },
  });
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await app.close();
});

describe('GET /api/vouchers/inbound-since', () => {
  const OLD = new Date('2026-06-01T00:00:00.000Z');
  const SINCE = new Date('2026-06-01T12:00:00.000Z');
  const RECENT = new Date('2026-06-01T18:00:00.000Z');

  it('since 以降の line/drive のみを source 別に数え、manual/別firmを除外する', async () => {
    await makeVoucher({ firmId: 'demo-firm', source: 'line', createdAt: OLD });    // 古いので除外
    await makeVoucher({ firmId: 'demo-firm', source: 'line', createdAt: RECENT });  // count
    await makeVoucher({ firmId: 'demo-firm', source: 'line', createdAt: RECENT });  // count
    await makeVoucher({ firmId: 'demo-firm', source: 'drive', createdAt: RECENT }); // count
    await makeVoucher({ firmId: 'demo-firm', source: 'manual', createdAt: RECENT });// manual除外
    await makeVoucher({ firmId: OTHER_FIRM, source: 'line', createdAt: RECENT });   // 別firm除外

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-since?since=' + encodeURIComponent(SINCE.toISOString()),
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts.line).toBe(2);
    expect(body.counts.drive).toBe(1);
    expect(body.total).toBe(3);
    expect(typeof body.now).toBe('string');
  });

  it('since 未指定なら total=0 で now を返す（過去分を通知しない）', async () => {
    await makeVoucher({ firmId: 'demo-firm', source: 'line', createdAt: RECENT });

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-since',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(typeof body.now).toBe('string');
  });
});
```

- [ ] **Step 2: テストを走らせて fail を確認**

Run: `cd server && npx vitest run tests/routes/vouchers-inbound-since.test.ts`
Expected: FAIL（404 か `body.counts` が undefined。ルート未実装のため）

- [ ] **Step 3: service に集計関数を追加**

`server/src/services/voucher-service.ts` の末尾に追加:

```ts
/**
 * spec 27: since より後・now 以下に投入された LINE/Drive 証憑を source 別に数える。
 * since が null の場合は now だけ返し total=0（初回アクセスで過去分を通知しないため）。
 * 区間を (since, now] にすることで、呼び出し側が次回 since=now を使えば二重計上しない。
 */
export async function countInboundSince(
  firmId: string,
  since: Date | null,
): Promise<{ now: Date; total: number; counts: { line: number; drive: number } }> {
  const now = new Date();
  if (!since) {
    return { now, total: 0, counts: { line: 0, drive: 0 } };
  }
  const grouped = await prisma.voucher.groupBy({
    by: ['source'],
    where: {
      firmId,
      source: { in: ['line', 'drive'] },
      createdAt: { gt: since, lte: now },
    },
    _count: { _all: true },
  });
  const counts = { line: 0, drive: 0 };
  for (const g of grouped) {
    if (g.source === 'line') counts.line = g._count._all;
    else if (g.source === 'drive') counts.drive = g._count._all;
  }
  return { now, total: counts.line + counts.drive, counts };
}
```

`prisma` は voucher-service.ts で import 済みか確認。未importなら先頭に `import { prisma } from '../lib/prisma.js';` を追加（既存の他関数が使っていれば不要）。

- [ ] **Step 4: ルートを追加**

`server/src/routes/vouchers.ts` の import に `countInboundSince` を足す:

```ts
import {
  createVoucher,
  listVouchers,
  getVoucherImage,
  deleteVoucher,
  runOcrForVoucher,
  countInboundSince,
} from '../services/voucher-service.js';
```

`voucherRoutes(app: FastifyInstance)` の関数内（他の `app.get` と並ぶ位置）に追加:

```ts
  app.get('/api/vouchers/inbound-since', async (req) => {
    const { since } = req.query as { since?: string };
    let sinceDate: Date | null = null;
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) sinceDate = d;
    }
    const result = await countInboundSince(req.user!.firmId, sinceDate);
    return {
      now: result.now.toISOString(),
      total: result.total,
      counts: result.counts,
    };
  });
```

- [ ] **Step 5: テストを走らせて pass を確認**

Run: `cd server && npx vitest run tests/routes/vouchers-inbound-since.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: コミット**

```bash
git add server/src/services/voucher-service.ts server/src/routes/vouchers.ts server/tests/routes/vouchers-inbound-since.test.ts
git commit -m "feat(spec 27): 証憑インバウンド集計エンドポイント GET /api/vouchers/inbound-since"
```

---

## Task 2: フロントのポーリング＋トースト

**Files:**
- Modify: `script.js`

フロントは test framework 無し。`node --check` の構文チェック＋手動UI検証で代用（プロジェクト方針）。

- [ ] **Step 1: appState にタイマー枠を追加**

`script.js` の `appState` オブジェクト（先頭付近、`lineLoadedAt: null,` の近く）に1行追加:

```js
  inboundPollTimer: null,
```

- [ ] **Step 2: 通知ロジックの関数を追加**

`script.js` の `showToast` 定義（`function showToast(message, type) {` 付近）の**直後**に追加:

```js
// spec 27: LINE/Drive からの証憑投入を検知してトースト表示する。
function buildInboundMessage(counts) {
  const parts = [];
  if (counts.line > 0) parts.push("LINEから" + counts.line + "件");
  if (counts.drive > 0) parts.push("Google Driveから" + counts.drive + "件");
  if (parts.length === 0) return "";
  return parts.join("、") + "の証憑が追加されました";
}

async function checkInboundVouchers() {
  if (typeof document !== "undefined" && document.hidden) return;
  const since = localStorage.getItem("bookmee.lastInboundSeenAt");
  try {
    const url = since
      ? "/api/vouchers/inbound-since?since=" + encodeURIComponent(since)
      : "/api/vouchers/inbound-since";
    const res = await apiFetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (since && data.total > 0) {
      const msg = buildInboundMessage(data.counts);
      if (msg) showToast(msg, "info");
    }
    if (data.now) localStorage.setItem("bookmee.lastInboundSeenAt", data.now);
  } catch (err) {
    console.warn("inbound voucher check failed", err);
  }
}

function startInboundPolling() {
  checkInboundVouchers();
  if (appState.inboundPollTimer) return;
  appState.inboundPollTimer = setInterval(checkInboundVouchers, 15000);
}
```

- [ ] **Step 3: ブートシーケンスに配線**

`script.js` の起動 IIFE（`loadClientsFromApi().finally(() => {` のブロック、`5963` 付近）を次のように変更:

変更前:
```js
  loadClientsFromApi().finally(() => {
    updateClientContextBar();
    applyHashRoute(true);
  });
```

変更後:
```js
  loadClientsFromApi().finally(() => {
    updateClientContextBar();
    applyHashRoute(true);
    startInboundPolling();
  });
```

- [ ] **Step 4: 構文チェック**

Run: `node --check script.js`
Expected: 出力なし（構文OK）

- [ ] **Step 5: コミット**

```bash
git add script.js
git commit -m "feat(spec 27): LINE/Drive証憑投入の通知トースト（15秒ポーリング＋再訪集約）"
```

---

## Task 3: 手動検証とデプロイ

**Files:** なし（運用手順）

- [ ] **Step 1: ローカルでバックエンド全テスト**

Run: `cd server && npx vitest run tests/routes/vouchers-inbound-since.test.ts`
Expected: PASS

- [ ] **Step 2: 手動UI検証（任意・ローカル or 本番）**

- LINE 経由で証憑を投入 → アプリ画面に 15 秒以内で「LINEから◯件の証憑が追加されました」トースト
- 別タブで開き直す → 前回以降の追加分が集約表示される（増分なしなら何も出ない）
- 手動アップロードでは通知が出ないこと

- [ ] **Step 3: 本番デプロイ（Railway CLI 手動）**

Run: `RAILWAY_TOKEN=<project token> railway up --service bookmee`
Expected: ビルド＆デプロイ成功。`https://bookmee-production.up.railway.app` で動作確認。

> トークンは Railway → Settings → Tokens（production env）で発行。使用後は revoke/再発行。

---

## Self-Review メモ

- **Spec coverage**: エンドポイント=Task1、リアルタイム/再訪通知/集約メッセージ/since管理=Task2、firm絞り・manual除外・since未指定=Task1テスト、受入基準の手動確認=Task3。網羅。
- **型整合**: `countInboundSince(firmId, since|null) → {now,total,counts:{line,drive}}` を Task1 で定義し、ルートと一致。フロントは `data.now/total/counts.line/counts.drive` を参照（一致）。
- **createdAt 二重計上回避**: 区間を `(since, now]` とし、クライアントは `now` を次回 since に保存。
