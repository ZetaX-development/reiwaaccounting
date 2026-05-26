# Spec 20: 証憑リマインドメール自動生成

**Date:** 2026-05-27
**Status:** Approved

---

## 目的

顧問先から当月分の証憑（領収書・請求書等）が届いていない場合に、担当スタッフがワンクリックで AI 生成のリマインドメールを作成し、既存のポータル送信機能でそのまま送信できるワークフローを提供する。

---

## ユーザーストーリー

> 担当者が「メッセージ」タブを開き、「証憑リマインドを作成」ボタンを押すと、AI が顧問先名・対象月・未提出件数を読み取り、自然な日本語のリマインドメール文面（件名＋本文）を下書きとして textarea に挿入する。担当者は必要に応じて編集し、「いま送る」ボタンで送信する。

---

## 機能範囲

### IN SCOPE

- `GET /api/clients/:id/reminder-draft?type=receipt` エンドポイント
  - 顧問先情報（名前・担当者名）を取得
  - 未マッチ Voucher 件数（`matchStatus = 'unmatched'`）を取得
  - 現在の月次モード（`mode-service`）から対象月を算出
  - OpenAI にコンテキストを渡し、メール件名＋本文を生成
  - `{ subject: string, body: string }` を返す
- フロントエンドのポータル UI に「証憑リマインドを作成」ボタンを追加
  - クリック → API 呼び出し → `#portalDraft` textarea に本文挿入
  - 送信は既存の `portal-send-now` / `portal-schedule` フローをそのまま利用

### OUT OF SCOPE

- メール以外のチャンネル（Slack 等）への文面最適化（フォーマット変換は既存 `formatForChannel` に委ねる）
- スケジュール送信のデフォルト設定
- 複数テンプレートタイプ（領収書リマインド以外）
- 自動送信（担当者が必ず確認・送信する）

---

## データフロー

```
[フロント] ポータル「証憑リマインドを作成」ボタン
    ↓
GET /api/clients/:id/reminder-draft?type=receipt
    ↓
reminder-draft-service.ts
  └─ prisma.client.findUnique({ name, ownerLabel, contactEndpoints })
  └─ prisma.voucher.count({ where: { clientId, matchStatus: 'unmatched' } })
  └─ 対象月を new Date() から算出（当月）
  └─ OpenAI chat completion（gpt-4o-mini）
    ↓
{ subject, body }
    ↓
[フロント] textarea に挿入 → ユーザー編集 → portal-send-now
```

---

## API 設計

### `GET /api/clients/:id/reminder-draft`

**Query params:**
- `type` = `"receipt"` (required, 現時点では receipt のみ)

**Response 200:**
```json
{
  "subject": "[経理丸ごとAI] 5月分 証憑のご提出をお願いいたします",
  "body": "青山デザイン 様\n\nいつもお世話になっております。\n..."
}
```

**Response 404:** クライアントが存在しない
**Response 400:** type が不正

---

## OpenAI プロンプト設計

**モデル:** `gpt-4o-mini`（コスト最適）

**System prompt:**
```
あなたは税理士事務所のスタッフとして、顧問先への丁寧なリマインドメールを書くアシスタントです。
簡潔で丁寧な日本語ビジネスメールを作成してください。
```

**User prompt:**
```
以下の状況に基づき、証憑（領収書・請求書）提出のリマインドメールを作成してください。

顧問先名: {clientName}
対象月: {targetMonth}（例: 2026年5月）
未提出証憑件数: {unmatchedCount} 件（0件の場合は「まだ証憑が届いていない状態」と表現）
担当者名: {ownerLabel}（空の場合は署名に含めない）

出力形式（JSON）:
{
  "subject": "件名（50文字以内）",
  "body": "本文（署名含む、300文字程度）"
}
```

---

## テスト方針

- `server/tests/services/reminder-draft-service.test.ts`
- OpenAI は `vi.spyOn` でモック（auxiliary service）
- テストケース:
  1. 未マッチ Voucher あり → subject/body が返る
  2. 未マッチ Voucher 0件 → subject/body が返る（0件用の文面）
  3. クライアント不存在 → `null` を返す

---

## 受入基準

1. ポータルタブの textarea に「証憑リマインドを作成」ボタンが表示される
2. ボタンを押すと spinner が出て、生成完了後に本文が textarea に挿入される
3. 挿入後、既存の「いま送る」で SendGrid 経由でメールが送信される（SENDGRID_API_KEY が設定済みの場合）
4. SENDGRID_API_KEY 未設定でも「送信失敗（SENDGRID未設定）」として Thread レコードに記録される

---

## 非ゴール

- AI が自動的に送信する仕組みは作らない（必ず人が確認）
- 既存の `outreach-service.ts`（個別証憑問い合わせ）は変更しない
