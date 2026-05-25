# Spec 19 — LINE インタラクティブ仕訳ヒアリング

作成日: 2026-05-25

## 目的

仕訳ドラフト生成で `missingFields` が残った場合（`journalStatus=needs_info`）、
LINE で不足情報を自動質問し、回答を受け取って仕訳を再生成する。

---

## 現状と差分

| | 現状 | 今回 |
|---|---|---|
| `needs_info` 後 | `journalStatus=needs_info` で止まる | LINE に質問を push |
| テキスト受信 | キャプション（次の画像の説明）としてのみ扱う | 質問待ちの場合は回答として扱う |
| 仕訳ドラフト | OCR 6フィールド + 業種のみ | + ユーザー回答（`lineAnswers`）も渡す |

---

## フロー

```
LINE から画像送信
  └→ createVoucher → runOcrForVoucher → assignAndMatchVoucher
       └→ generateDraftJournal
            ├─ missingFields=[] → journalStatus=drafted → ✅ OK / 🔄 直す quickreply（既存）
            └─ missingFields=[...] → journalStatus=needs_info
                 └→ sendLinePushForVoucherStatus (needs_info ブランチ)
                      └→ LINE に質問を push（例:「誰と食事しましたか？」）
                           └→ pendingQuestionCache[lineUserId] = { voucherId, field }

ユーザーが LINE にテキスト返信
  └→ handleTextMessage
       └→ pendingQuestionCache に該当あり → answerPendingQuestion()
            └→ Voucher.lineAnswers に { field: answer } を保存
            └→ generateDraftJournal(voucherId) 再実行
                 ├─ missingFields=[] → drafted → ✅ OK / 🔄 直す quickreply
                 └─ まだ足りない → 次の質問を push
```

---

## データモデル変更

`Voucher` に 1フィールド追加（マイグレーション必要）:

```prisma
lineAnswers Json?  // { "会食の参加者": "田中部長、鈴木様", ... }
```

---

## `journal-draft-service.ts` の変更

`generateDraftJournal` 内の `userPayload` に `lineAnswers` を追加:

```ts
const lineAnswers = (voucher.lineAnswers ?? {}) as Record<string, string>;
const userPayload = {
  vendor_name: ocr.vendor_name,
  ...
  追加情報: lineAnswers,   // ユーザーが回答した内容
};
```

システムプロンプトに一文追加:
> `追加情報` フィールドにスタッフから補足が入っている場合は最優先で使ってください。

---

## `line-importer.ts` の変更

### 1. `pendingQuestionCache`（in-memory）

```ts
interface PendingQuestion {
  voucherId: string;
  field: string;        // missingFields[0]
  askedAt: number;
}
const pendingQuestionCache = new Map<string, PendingQuestion>();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10分
```

### 2. `sendLinePushForVoucherStatus` に `needs_info` 分岐追加

```ts
if (v.journalStatus === 'needs_info') {
  const fields = (v.draftJournalJson as any)?.missingFields ?? [];
  const field = fields[0];
  if (!field) return;
  const question = buildQuestion(field);
  await lineService.pushMessage(v.lineUserId, [{ type: 'text', text: question }]);
  pendingQuestionCache.set(v.lineUserId, { voucherId, field, askedAt: Date.now() });
}
```

### 3. `buildQuestion(field)` ヘルパー

よくある `missingFields` を自然な質問文に変換する:

| field（AI が出力する文字列） | 質問文 |
|---|---|
| 会食の参加者 | 誰と食事されましたか？（例: 田中様） |
| 出張の目的 | 出張の目的を教えてください |
| 支払方法（現金/カード/振込） | 支払方法を教えてください（現金・カード・振込） |
| 用途・目的 | 経費の用途・目的を教えてください |
| その他（fallback） | 「{field}」を教えてください |

### 4. `handleTextMessage` の変更

```ts
function handleTextMessage(userId: string, text: string): void {
  // 質問待ちの回答を優先
  const pending = pendingQuestionCache.get(userId);
  if (pending && Date.now() - pending.askedAt < PENDING_TTL_MS) {
    pendingQuestionCache.delete(userId);
    setImmediate(() => {
      answerPendingQuestion(pending.voucherId, pending.field, text).catch(() => {});
    });
    return;
  }
  // 従来のキャプション動作
  captionCache.set(userId, { text, capturedAt: Date.now() });
}
```

### 5. `answerPendingQuestion` 新関数

```ts
async function answerPendingQuestion(
  voucherId: string, field: string, answer: string
): Promise<void> {
  const voucher = await prisma.voucher.findUnique({ where: { id: voucherId }, select: { lineAnswers: true, lineUserId: true } });
  if (!voucher?.lineUserId) return;
  const existing = (voucher.lineAnswers ?? {}) as Record<string, string>;
  await prisma.voucher.update({
    where: { id: voucherId },
    data: { lineAnswers: { ...existing, [field]: answer } },
  });
  // 仕訳ドラフト再生成
  const { generateDraftJournal } = await import('./journal-draft-service.js');
  await generateDraftJournal(voucherId);
  // 結果を通知（再度 sendLinePushForVoucherStatus を呼ぶ）
  await sendLinePushForVoucherStatus(voucherId);
}
```

---

## テスト方針

`server/tests/services/line-importer.test.ts` に追加:

1. `needs_info` のとき LINE に質問が push される
2. 質問後にテキスト返信 → `Voucher.lineAnswers` に保存される
3. TTL 切れ（10分超）の pending は回答として扱わずキャプションとして扱う
4. `journal-draft-service.ts`: `lineAnswers` がある場合は user payload に含まれる

---

## 受入基準

- [ ] `journalStatus=needs_info` になると自動で LINE 質問が来る
- [ ] テキスト返信すると `lineAnswers` に保存され仕訳が再生成される
- [ ] 再生成後に `drafted` になれば従来の ✅ quickreply が届く
- [ ] TTL 切れの pending はキャプションにフォールバック
- [ ] 既存 156 テスト回帰なし

## 非ゴール

- 複数の `missingFields` を一度に全部聞く（1問ずつ順番に聞く）
- LINE 以外（メール・Slack）での同様のヒアリング
- 回答内容のバリデーション（何でも受け入れる）
