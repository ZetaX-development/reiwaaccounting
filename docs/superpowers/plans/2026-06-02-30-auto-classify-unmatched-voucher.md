# MF一致なし証憑の自動仕訳確定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MF一致なしの証憑で、不足情報が全て解消されてドラフトが完成した瞬間に、人手承認なしで `journalStatus='approved'`（仕訳確定）へ自動昇格する。

**Architecture:** 中核は `generateDraftJournal` の状態決定1箇所。`missingFields` が空 かつ `matchStatus !== 'matched'` のとき `drafted` ではなく `approved` にし、`draftJournalJson.autoClassified=true` を付与。LINE 証憑は確定時に「登録しました」通知のみ。フロントは突合結果バッジを「自動仕訳済」と出し分け。スキーマ変更なし。

**Tech Stack:** Fastify + Prisma + Vanilla JS。テストは vitest（実Postgres、OpenAI/LINEはモック/spy）。

参照スペック: `docs/superpowers/specs/2026-06-02-30-auto-classify-unmatched-voucher-design.md`

---

## File Structure

- `server/src/services/journal-draft-service.ts`（**Modify**）— 状態決定に自動確定ロジック追加（中核）
- `server/tests/services/journal-draft-service.test.ts`（**Modify**）— 既存「不足なし→drafted」を「未一致→approved」に更新＋matched分岐テスト追加
- `server/src/services/line-importer.ts`（**Modify**）— `sendLinePushForVoucherStatus` に approved+autoClassified 通知ブランチ追加
- `server/tests/services/line-importer.test.ts`（**Modify**）— 自動確定通知のテスト追加
- `script.js`（**Modify**）— 突合結果の approved バッジを autoClassified で出し分け

---

## Task 1: 自動確定ロジック（中核）

**Files:**
- Modify: `server/src/services/journal-draft-service.ts`
- Test: `server/tests/services/journal-draft-service.test.ts`

- [ ] **Step 1: 既存テストを更新し、matched 用テストを追加（失敗するテストを作る）**

`server/tests/services/journal-draft-service.test.ts`:

(a) `createVoucherFixture` に matchStatus パラメータを追加（既存呼び出しは引数1つのままで動く）:

```ts
async function createVoucherFixture(
  ocrJson: unknown,
  matchStatus = 'unmatched',
): Promise<string> {
  const v = await prisma.voucher.create({
    data: {
      firmId: 'demo-firm',
      clientId: 'aoyama-design',
      filename: 'sample.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      imageData: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      ocrStatus: 'done',
      ocrJson: ocrJson as never,
      matchStatus,
    },
  });
  return v.id;
}
```

(b) 既存テスト `it('persists a drafted journal when OpenAI returns no missing fields', ...)` の**期待値を更新**する。`createVoucherFixture` は `matchStatus:'unmatched'` なので、spec 30 後は `approved` になる。テスト名と assert を次に置き換える:

```ts
  it('auto-classifies (approved) when unmatched and no missing fields', async () => {
    const id = await createVoucherFixture({
      issue_date: '2026-05-15',
      vendor_name: 'ハラペコステーキ',
      addressee: '青山デザイン株式会社',
      amount: 12000,
      invoice_number: 'T1234567890123',
    });

    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              transactionDate: '2026-05-15',
              debit: { account: '接待交際費', subAccount: null, partner: 'ハラペコステーキ', taxClass: '課税仕入10%', invoiceNumber: 'T1234567890123', amount: 12000 },
              credit: { account: '現金', subAccount: null, partner: null, taxClass: '対象外', invoiceNumber: null, amount: 12000 },
              description: 'ハラペコステーキ — 取引先との会食',
              missingFields: [],
              reasoning: '請求書の宛名と業種から会食と判断',
            }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({ chat: { completions: { create } } }));

    await generateDraftJournal(id);

    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.journalStatus).toBe('approved');
    expect(row?.draftJournalJson).toMatchObject({
      debit: { account: '接待交際費', amount: 12000 },
      missingFields: [],
      autoClassified: true,
    });
  });
```

(c) **新規テストを追加**（matched は自動確定しない）。同 describe 内に追記:

```ts
  it('keeps drafted (no auto-classify) when matchStatus is matched', async () => {
    const id = await createVoucherFixture(
      {
        issue_date: '2026-05-15',
        vendor_name: 'ハラペコステーキ',
        addressee: '青山デザイン株式会社',
        amount: 12000,
        invoice_number: 'T1234567890123',
      },
      'matched',
    );

    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              transactionDate: '2026-05-15',
              debit: { account: '接待交際費', subAccount: null, partner: 'ハラペコステーキ', taxClass: '課税仕入10%', invoiceNumber: null, amount: 12000 },
              credit: { account: '現金', subAccount: null, partner: null, taxClass: '対象外', invoiceNumber: null, amount: 12000 },
              description: '会食',
              missingFields: [],
              reasoning: 'x',
            }),
          },
        },
      ],
    });
    MockedOpenAI.mockImplementation(() => ({ chat: { completions: { create } } }));

    await generateDraftJournal(id);

    const row = await prisma.voucher.findUnique({ where: { id } });
    expect(row?.journalStatus).toBe('drafted');
    expect((row?.draftJournalJson as { autoClassified?: boolean })?.autoClassified).toBeUndefined();
  });
```

（既存の `needs_info` テストはそのまま＝未一致＋missingFieldsあり→needs_info を維持。）

- [ ] **Step 2: テストを走らせて fail を確認**

Run: `cd server && npx vitest run tests/services/journal-draft-service.test.ts`
Expected: `auto-classifies (approved) ...` が FAIL（現状コードは `drafted` を返すため `approved` 期待で落ちる）。matched と needs_info は PASS。

- [ ] **Step 3: generateDraftJournal を実装**

`server/src/services/journal-draft-service.ts`:

(a) 冒頭の Voucher 取得 select に `matchStatus` を追加:

```ts
  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { id: true, clientId: true, ocrJson: true, lineAnswers: true, matchStatus: true },
  });
```

(b) 成功時の status 決定と update を次に置き換える（現在 `const nextStatus = parsed.missingFields.length > 0 ? 'needs_info' : 'drafted';` から始まる update ブロック）:

```ts
    const hasMissing = parsed.missingFields.length > 0;
    // spec 30: 不足情報が全て解消され、かつ MF 未一致なら、人手承認なしで自動確定する。
    const autoClassify = !hasMissing && voucher.matchStatus !== 'matched';
    const nextStatus = hasMissing
      ? 'needs_info'
      : autoClassify
        ? 'approved'
        : 'drafted';
    const draftToSave = autoClassify
      ? { ...parsed, autoClassified: true }
      : parsed;
    await prisma.voucher.update({
      where: { id: voucherId },
      data: {
        draftJournalJson: draftToSave as unknown as object,
        journalStatus: nextStatus,
      },
    });
```

- [ ] **Step 4: テストを走らせて pass を確認**

Run: `cd server && npx vitest run tests/services/journal-draft-service.test.ts`
Expected: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add server/src/services/journal-draft-service.ts server/tests/services/journal-draft-service.test.ts
git commit -m "feat(spec 30): MF一致なし証憑のドラフト完成時に自動で仕訳確定(approved)"
```

---

## Task 2: LINE 自動確定通知（通知のみ）

**Files:**
- Modify: `server/src/services/line-importer.ts`
- Test: `server/tests/services/line-importer.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/line-importer.test.ts` の末尾付近に describe を追加:

```ts
describe('sendLinePushForVoucherStatus — auto-classified', () => {
  it('pushes a confirmation (no quick reply) when approved & autoClassified', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    __resetEnvCache();

    const v = await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: null,
        filename: 'a.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        imageData: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        source: 'line',
        lineUserId: 'Uauto',
        journalStatus: 'approved',
        draftJournalJson: {
          transactionDate: '2026-05-25',
          debit: { account: '消耗品費', subAccount: null, partner: null, taxClass: '課税仕入10%', invoiceNumber: null, amount: 1200 },
          credit: { account: '現金', subAccount: null, partner: null, taxClass: '対象外', invoiceNumber: null, amount: 1200 },
          description: 'x',
          missingFields: [],
          autoClassified: true,
        } as never,
      },
    });

    const pushSpy = vi.spyOn(lineService, 'pushMessage').mockResolvedValue(undefined);
    const qrSpy = vi.spyOn(lineService, 'pushQuickReply').mockResolvedValue(undefined);

    await sendLinePushForVoucherStatus(v.id);

    expect(pushSpy).toHaveBeenCalledOnce();
    const [userId, messages] = pushSpy.mock.calls[0];
    expect(userId).toBe('Uauto');
    expect((messages[0] as { type: string; text: string }).text).toContain('仕訳に登録しました');
    expect(qrSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストを走らせて fail を確認**

Run: `cd server && npx vitest run tests/services/line-importer.test.ts -t "auto-classified"`
Expected: FAIL（現状 `approved` は分岐が無く push されないので `toHaveBeenCalledOnce` で落ちる）。

- [ ] **Step 3: 通知ブランチを実装**

`server/src/services/line-importer.ts` の `sendLinePushForVoucherStatus` 内、`if (v.journalStatus === 'drafted') {` の**直前**に次を追加:

```ts
  // spec 30: 自動確定された証憑は LINE に「登録しました」通知のみ（ボタンなし）。
  if (v.journalStatus === 'approved') {
    const draft = (v.draftJournalJson ?? {}) as Record<string, unknown>;
    if (draft.autoClassified === true) {
      const debit = (typeof draft.debit === 'object' && draft.debit !== null ? draft.debit : {}) as Record<string, unknown>;
      const account =
        typeof debit.account === 'string' ? debit.account :
        typeof draft.account === 'string' ? draft.account :
        '（勘定科目）';
      const amount =
        typeof debit.amount === 'number'
          ? `¥${debit.amount.toLocaleString('ja-JP')}`
          : typeof draft.amount === 'number'
            ? `¥${draft.amount.toLocaleString('ja-JP')}`
            : '';
      const text = `✓ ${account} ${amount} で仕訳に登録しました。`.trim();
      await lineService.pushMessage(v.lineUserId, [{ type: 'text', text }]);
    }
    return;
  }
```

- [ ] **Step 4: テストを走らせて pass を確認**

Run: `cd server && npx vitest run tests/services/line-importer.test.ts`
Expected: 追加テスト含め全 PASS。

- [ ] **Step 5: コミット**

```bash
git add server/src/services/line-importer.ts server/tests/services/line-importer.test.ts
git commit -m "feat(spec 30): 自動確定したLINE証憑に登録完了通知（ボタンなし）"
```

---

## Task 3: フロントの「自動仕訳済」バッジ

**Files:**
- Modify: `script.js`

test framework 無し → `node --check` ＋ 手動検証。

- [ ] **Step 1: approved バッジを autoClassified で出し分け**

`script.js` の突合結果ドラフト表示（`const statusBadge =` のブロック）の `js === 'approved'` 分岐を変更:

変更前:
```js
        const statusBadge =
          js === 'approved'
            ? '<span class="matching-draft-badge badge-approved">承認済</span>'
            : js === 'inquired'
```

変更後:
```js
        const statusBadge =
          js === 'approved'
            ? (dj.autoClassified
                ? '<span class="matching-draft-badge badge-approved">自動仕訳済</span>'
                : '<span class="matching-draft-badge badge-approved">承認済</span>')
            : js === 'inquired'
```

- [ ] **Step 2: 構文チェック**

Run: `node --check script.js`
Expected: 出力なし（OK）。

- [ ] **Step 3: コミット**

```bash
git add script.js
git commit -m "feat(spec 30): 突合結果で自動確定を『自動仕訳済』バッジ表示"
```

---

## Task 4: 全体検証とデプロイ

**Files:** なし（運用）

- [ ] **Step 1: 関連テストをまとめて実行**

Run: `cd server && npx vitest run tests/services/journal-draft-service.test.ts tests/services/line-importer.test.ts`
Expected: 全 PASS。

- [ ] **Step 2: 手動UI検証（任意）**

- 不足情報のある LINE 証憑を送る → ヒアリング → 回答 → 「✓ 〇〇 ¥X で仕訳に登録しました」通知が届き、突合結果で「自動仕訳済」バッジになる。
- 不足情報が残る間は `needs_info` のまま突合結果に蓄積され、確定しないこと。

- [ ] **Step 3: 本番デプロイ（Railway CLI 手動）**

Run: `RAILWAY_TOKEN=<project token> railway up --service bookmee`
Expected: ビルド＆デプロイ成功。

> トークンは Railway → Settings → Tokens（production）で発行。使用後は revoke/再発行。

---

## Self-Review メモ

- **Spec coverage**: 自動確定（受入1,5）=Task1、不足ありは確定しない（受入2）=Task1の needs_info テスト維持、autoClassifiedマーカー（受入3）=Task1、LINE通知（受入4）=Task2、CSV対象（受入6）=既存挙動で変更不要、可視化=Task3。網羅。
- **既存テスト破壊への対応**: `journal-draft-service.test.ts` の「unmatched＋不足なし→drafted」は spec 30 で approved に変わるため Task1 Step1 で更新済み（プランに明記）。
- **型/値整合**: `matchStatus` 値は `matched/unmatched/no_client/no_data`。判定は `!== 'matched'`。`autoClassified` は draftJournalJson(JSON) 内のフラグで統一（バックエンド書き込み・LINE参照・フロント参照すべて同名）。
