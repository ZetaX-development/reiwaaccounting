# 証憑追加の通知センター Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 右上ベルに LINE/Drive 由来の証憑追加を溜め、一覧→クリックで該当証憑の突合結果へジャンプ、「クリア」で既読化する通知センターを追加する。

**Architecture:** バックエンドに最近の line/drive 証憑を返す `GET /api/vouchers/inbound-recent` を1本追加。フロントは spec27 の 15 秒ポーラーに相乗りして一覧を取得し、右上ベル＋未読バッジ＋パネルを描画。既存トーストは不変。スキーマ変更なし。

**Tech Stack:** Fastify + Prisma + Vanilla JS。テストは vitest（実Postgres）。フロントは node --check ＋手動。

参照スペック: `docs/superpowers/specs/2026-06-02-31-inbound-notification-center-design.md`

---

## File Structure

- `server/src/services/voucher-service.ts`（**Modify**）— `listInboundRecent` 追加
- `server/src/routes/vouchers.ts`（**Modify**）— `GET /api/vouchers/inbound-recent` 追加
- `server/tests/routes/vouchers-inbound-recent.test.ts`（**Create**）— エンドポイントのテスト
- `index.html`（**Modify**）— topbar-actions にベル＋パネルのマークアップ
- `styles.css`（**Modify**）— ベル/バッジ/パネルの最小スタイル
- `script.js`（**Modify**）— 状態・取得・バッジ・パネル・クリア・ジャンプ・ハイライト・配線

---

## Task 1: バックエンド `inbound-recent` エンドポイント

**Files:**
- Modify: `server/src/services/voucher-service.ts`
- Modify: `server/src/routes/vouchers.ts`
- Test: `server/tests/routes/vouchers-inbound-recent.test.ts`

- [ ] **Step 1: 失敗テストを書く**

Create `server/tests/routes/vouchers-inbound-recent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { authHeaders } from '../helpers/auth.js';

const app = await buildApp();
const auth = await authHeaders();
const OTHER_FIRM = 'inbound-recent-other-firm';

async function mk(opts: {
  firmId: string;
  source: string;
  uploadedAt: Date;
  clientId?: string | null;
  ocrJson?: unknown;
  draftJournalJson?: unknown;
}) {
  return prisma.voucher.create({
    data: {
      firmId: opts.firmId,
      source: opts.source,
      uploadedAt: opts.uploadedAt,
      clientId: opts.clientId ?? null,
      filename: 'x.png',
      mimeType: 'image/png',
      size: 3,
      imageData: Buffer.from([0x89, 0x50, 0x4e]),
      ocrJson: (opts.ocrJson ?? null) as never,
      draftJournalJson: (opts.draftJournalJson ?? null) as never,
    },
  });
}

beforeEach(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await prisma.firm.create({ data: { id: OTHER_FIRM, name: 'Other', slug: OTHER_FIRM } });
});

afterAll(async () => {
  await prisma.voucher.deleteMany();
  await prisma.firm.deleteMany({ where: { id: OTHER_FIRM } });
  await app.close();
});

describe('GET /api/vouchers/inbound-recent', () => {
  const t = (min: number) => new Date(Date.now() - min * 60000);

  it('returns line/drive only, firm-scoped, newest first, with derived fields', async () => {
    await mk({
      firmId: 'demo-firm', source: 'line', uploadedAt: t(1), clientId: 'shibuya-cafe',
      ocrJson: { vendor_name: 'MOS', amount: 940 },
      draftJournalJson: { debit: { account: '会議費', amount: 940 } },
    });
    await mk({ firmId: 'demo-firm', source: 'drive', uploadedAt: t(5) });
    await mk({ firmId: 'demo-firm', source: 'manual', uploadedAt: t(2) }); // 除外
    await mk({ firmId: OTHER_FIRM, source: 'line', uploadedAt: t(0) });     // 別firm除外

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-recent?limit=20',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2); // line + drive のみ
    // 新しい順: line(1分前) が先頭
    expect(body[0].source).toBe('line');
    expect(body[0].vendor).toBe('MOS');
    expect(body[0].amount).toBe(940);
    expect(body[0].account).toBe('会議費');
    expect(body[0].clientId).toBe('shibuya-cafe');
    expect(typeof body[0].clientName).toBe('string'); // shibuya-cafe の名前
    expect(body[1].source).toBe('drive');
  });

  it('respects limit', async () => {
    await mk({ firmId: 'demo-firm', source: 'line', uploadedAt: t(1) });
    await mk({ firmId: 'demo-firm', source: 'line', uploadedAt: t(2) });
    await mk({ firmId: 'demo-firm', source: 'line', uploadedAt: t(3) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/vouchers/inbound-recent?limit=2',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: テストを走らせて fail を確認**

Run: `cd server && npx vitest run tests/routes/vouchers-inbound-recent.test.ts`
Expected: FAIL（404 / ルート未実装）。

- [ ] **Step 3: service に集計関数を追加**

`server/src/services/voucher-service.ts` 末尾に追加:

```ts
/**
 * spec 31: 通知センター用。firm 内の最近の LINE/Drive 証憑を新しい順で返す。
 */
export async function listInboundRecent(
  firmId: string,
  limit: number,
): Promise<Array<{
  id: string;
  source: string;
  uploadedAt: Date;
  vendor: string | null;
  amount: number | null;
  account: string | null;
  clientId: string | null;
  clientName: string | null;
  journalStatus: string;
}>> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const rows = await prisma.voucher.findMany({
    where: { firmId, source: { in: ['line', 'drive'] } },
    orderBy: { uploadedAt: 'desc' },
    take: capped,
    select: {
      id: true,
      source: true,
      uploadedAt: true,
      journalStatus: true,
      clientId: true,
      ocrJson: true,
      draftJournalJson: true,
      client: { select: { name: true } },
    },
  });
  return rows.map((r) => {
    const ocr = (r.ocrJson ?? {}) as { vendor_name?: unknown; amount?: unknown };
    const draft = (r.draftJournalJson ?? {}) as { debit?: { account?: unknown; amount?: unknown } };
    const debit = draft.debit ?? {};
    const amount =
      typeof ocr.amount === 'number'
        ? ocr.amount
        : typeof debit.amount === 'number'
          ? debit.amount
          : null;
    return {
      id: r.id,
      source: r.source,
      uploadedAt: r.uploadedAt,
      vendor: typeof ocr.vendor_name === 'string' ? ocr.vendor_name : null,
      amount,
      account: typeof debit.account === 'string' ? debit.account : null,
      clientId: r.clientId,
      clientName: r.client?.name ?? null,
      journalStatus: r.journalStatus,
    };
  });
}
```

- [ ] **Step 4: ルートを追加**

`server/src/routes/vouchers.ts` の import に `listInboundRecent` を足す（`countInboundSince` と並べて）:

```ts
  countInboundSince,
  listInboundRecent,
} from '../services/voucher-service.js';
```

`voucherRoutes` 内、`inbound-since` ルートの直後に追加:

```ts
  // spec 31: 通知センター用。最近の LINE/Drive 証憑を一覧で返す。
  app.get('/api/vouchers/inbound-recent', async (req) => {
    const { limit } = req.query as { limit?: string };
    const n = limit ? Number(limit) : 20;
    const result = await listInboundRecent(req.user!.firmId, Number.isFinite(n) ? n : 20);
    return result.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString() }));
  });
```

- [ ] **Step 5: テストを走らせて pass を確認**

Run: `cd server && npx vitest run tests/routes/vouchers-inbound-recent.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 6: コミット**

```bash
git add server/src/services/voucher-service.ts server/src/routes/vouchers.ts server/tests/routes/vouchers-inbound-recent.test.ts
git commit -m "feat(spec 31): 通知センター用 GET /api/vouchers/inbound-recent"
```

---

## Task 2: ベル・バッジ・取得（フロント）

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `script.js`

- [ ] **Step 1: ベル＋パネルのマークアップを追加**

`index.html` の `<div class="topbar-actions">` 直下（検索ボックスの前）に追加:

```html
            <div class="notif-wrap">
              <button class="notif-bell" id="notifBell" type="button" aria-label="通知">🔔<span class="notif-badge" id="notifBadge" hidden></span></button>
              <div class="notif-panel" id="notifPanel" hidden></div>
            </div>
```

- [ ] **Step 2: 最小スタイルを追加**

`styles.css` 末尾に追加:

```css
.notif-wrap { position: relative; display: inline-flex; align-items: center; }
.notif-bell { position: relative; background: none; border: none; font-size: 18px; cursor: pointer; line-height: 1; padding: 6px; }
.notif-badge { position: absolute; top: -2px; right: -2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #ef4444; color: #fff; font-size: 11px; line-height: 16px; text-align: center; }
.notif-panel { position: absolute; top: 36px; right: 0; width: 320px; max-height: 420px; overflow-y: auto; background: #fff; color: #0f172a; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,0.18); z-index: 1000; padding: 6px; }
.notif-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; font-weight: 600; }
.notif-head button { background: none; border: 1px solid #e2e8f0; border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
.notif-item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; background: none; border: none; border-radius: 8px; padding: 8px; cursor: pointer; }
.notif-item:hover { background: #f1f5f9; }
.notif-unread { background: #ecfdf5; }
.notif-source { font-size: 11px; color: #059669; font-weight: 600; }
.notif-main { font-size: 13px; }
.notif-sub { font-size: 11px; color: #64748b; }
.notif-empty { padding: 16px; color: #64748b; font-size: 13px; text-align: center; }
.voucher-highlight { outline: 3px solid #10b981; outline-offset: 2px; transition: outline 0.2s; }
```

- [ ] **Step 3: 状態・取得・バッジ関数を追加**

`script.js` の `appState` に1行追加（`inboundPollTimer: null,` の近く）:

```js
  notifications: [],
```

`startInboundPolling` 関数の直前（または `checkInboundVouchers` の近く）に追加:

```js
// spec 31: 通知センター。最近の LINE/Drive 証憑を取得して未読バッジを更新する。
async function refreshNotifications() {
  try {
    const res = await apiFetch('/api/vouchers/inbound-recent?limit=20');
    if (!res.ok) return;
    appState.notifications = await res.json();
    if (!localStorage.getItem('bookmee.notifSeenAt')) {
      localStorage.setItem('bookmee.notifSeenAt', new Date().toISOString());
    }
    renderNotifBadge();
  } catch (err) {
    console.warn('refreshNotifications failed', err);
  }
}

function notifUnreadCount() {
  const seen = localStorage.getItem('bookmee.notifSeenAt') || '';
  return (appState.notifications || []).filter((n) => n.uploadedAt > seen).length;
}

function renderNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const n = notifUnreadCount();
  if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
  else { badge.hidden = true; }
}
```

- [ ] **Step 4: ポーリングと初期化に配線**

`checkInboundVouchers` の最後（`}` の手前、catch の前の try 末尾）に1行足す代わりに、関数末尾で `refreshNotifications()` を呼ぶ形にする。`startInboundPolling` を次に置き換える:

```js
function startInboundPolling() {
  checkInboundVouchers();
  refreshNotifications();
  if (appState.inboundPollTimer) return;
  appState.inboundPollTimer = setInterval(() => {
    checkInboundVouchers();
    refreshNotifications();
  }, 15000);
}
```

- [ ] **Step 5: 構文チェック**

Run: `node --check script.js`
Expected: 出力なし。

- [ ] **Step 6: コミット**

```bash
git add index.html styles.css script.js
git commit -m "feat(spec 31): 通知ベル＋未読バッジ＋15秒取得"
```

---

## Task 3: パネル表示・クリア・ジャンプ・ハイライト

**Files:**
- Modify: `script.js`

- [ ] **Step 1: パネル描画とイベント配線を追加**

`script.js` の `renderNotifBadge` の直後に追加:

```js
function notifSourceLabel(s) { return s === 'line' ? 'LINE' : s === 'drive' ? 'Drive' : s; }

function notifRelTime(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return m + '分前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '時間前';
  return Math.floor(h / 24) + '日前';
}

function renderNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const seen = localStorage.getItem('bookmee.notifSeenAt') || '';
  const items = appState.notifications || [];
  const rows = items.length
    ? items.map((n) => {
        const unread = n.uploadedAt > seen;
        const amt = n.amount != null ? '¥' + Number(n.amount).toLocaleString('ja-JP') : '';
        const acct = n.account || '（未分類）';
        const cli = n.clientName || '未割当';
        return `<button class="notif-item${unread ? ' notif-unread' : ''}" data-notif-voucher="${n.id}" data-notif-client="${n.clientId || ''}">
          <span class="notif-source">${notifSourceLabel(n.source)}</span>
          <span class="notif-main">${escapeHtml(acct)} ${amt}</span>
          <span class="notif-sub">${escapeHtml(cli)} ・ ${notifRelTime(n.uploadedAt)}</span>
        </button>`;
      }).join('')
    : '<div class="notif-empty">通知はありません</div>';
  panel.innerHTML = `<div class="notif-head"><span>通知</span><button id="notifClear" type="button">クリア</button></div>${rows}`;
}

function highlightVoucherAfterRender(voucherId, tries) {
  tries = tries || 0;
  const el = document.getElementById('voucher-card-' + voucherId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('voucher-highlight');
    setTimeout(() => el.classList.remove('voucher-highlight'), 2000);
    return;
  }
  if (tries < 20) setTimeout(() => highlightVoucherAfterRender(voucherId, tries + 1), 150);
}

function setupNotifications() {
  const bell = document.getElementById('notifBell');
  const panel = document.getElementById('notifPanel');
  if (!bell || !panel) return;
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) { renderNotifPanel(); panel.hidden = false; }
    else { panel.hidden = true; }
  });
  panel.addEventListener('click', (e) => {
    const clr = e.target.closest('#notifClear');
    if (clr) {
      localStorage.setItem('bookmee.notifSeenAt', new Date().toISOString());
      renderNotifBadge();
      renderNotifPanel();
      return;
    }
    const item = e.target.closest('[data-notif-voucher]');
    if (item) {
      appState.matchingTab = item.dataset.notifClient || 'unassigned';
      panel.hidden = true;
      location.hash = '#/matching-results';
      highlightVoucherAfterRender(item.dataset.notifVoucher);
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target.id !== 'notifBell') {
      panel.hidden = true;
    }
  });
}
```

- [ ] **Step 2: 初期化で setupNotifications を呼ぶ**

`script.js` の起動 IIFE の `loadClientsFromApi().finally(...)` ブロックを次に置き換える（`startInboundPolling()` の後に1行追加）:

変更前:
```js
  loadClientsFromApi().finally(() => {
    updateClientContextBar();
    applyHashRoute(true);
    startInboundPolling();
  });
```

変更後:
```js
  loadClientsFromApi().finally(() => {
    updateClientContextBar();
    applyHashRoute(true);
    setupNotifications();
    startInboundPolling();
  });
```

- [ ] **Step 3: pending カードにハイライト用 id を付与**

`script.js` の突合結果 pending カードのルート要素に id を追加。

変更前:
```js
      return `
      <div class="matching-card-pending">
        <img data-voucher-img="${v.id}" alt="${escapeHtml(v.filename)}" style="background:#f3f4f6;" />
```

変更後:
```js
      return `
      <div class="matching-card-pending" id="voucher-card-${v.id}">
        <img data-voucher-img="${v.id}" alt="${escapeHtml(v.filename)}" style="background:#f3f4f6;" />
```

- [ ] **Step 4: 構文チェック**

Run: `node --check script.js`
Expected: 出力なし。

- [ ] **Step 5: コミット**

```bash
git add script.js
git commit -m "feat(spec 31): 通知パネル表示・クリア既読・クリックで突合結果へジャンプ＆ハイライト"
```

---

## Task 4: 検証とデプロイ

**Files:** なし（運用）

- [ ] **Step 1: バックエンドテスト**

Run: `cd server && npx vitest run tests/routes/vouchers-inbound-recent.test.ts tests/routes/vouchers-inbound-since.test.ts`
Expected: 全 PASS。

- [ ] **Step 2: 手動UI検証（任意）**

- LINE/Drive で証憑追加 → 15 秒以内に右上ベルのバッジが増える。
- ベルを開く → 一覧（LINE/Drive・勘定科目・金額・顧問先・相対時刻）。クリックで突合結果へ遷移＆該当証憑がハイライト。
- 「クリア」でバッジ 0（開いただけでは 0 にならない）。
- 既存トーストは従来どおり出る。

- [ ] **Step 3: 本番デプロイ（Railway CLI 手動）**

Run: `RAILWAY_TOKEN=<project token> railway up --service bookmee`
Expected: ビルド＆デプロイ成功、health 200。

> トークンは Railway → Settings → Tokens（production）で発行。使用後は revoke/再発行。

---

## Self-Review メモ

- **Spec coverage**: バッジ増加(受入1)=Task2、一覧詳細(受入2)=Task3、クリックでジャンプ＆ハイライト(受入3)=Task3、クリアで既読(受入4)=Task3、manual/別firm除外(受入5)=Task1テスト、トースト不変(受入6)=変更せず、API失敗で壊れない(受入7)=refreshNotifications の try/catch。網羅。
- **型/プロパティ整合**: エンドポイントは `{id, source, uploadedAt(ISO文字列), vendor, amount, account, clientId, clientName, journalStatus}` を返し、フロントは `n.id/source/uploadedAt/amount/account/clientName/clientId` を参照（一致）。未読判定は ISO(UTC) 文字列の辞書順比較＝時系列順で正しい。
- **ジャンプ整合**: `matchingTab` 初期化は `if (!appState.matchingTab)` ガードのため、ジャンプ前セットは上書きされない。pending カードに `id="voucher-card-<id>"` を付与しハイライト対象にする。
