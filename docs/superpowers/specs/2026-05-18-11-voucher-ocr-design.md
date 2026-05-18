# 11. 証憑 OCR（OpenAI Vision で項目抽出）

作成日: 2026-05-18

## 位置づけ

spec 10 で保管された Voucher 画像に対し、OpenAI Vision を呼んで構造化フィールドを抽出する。A→B→C→D の **B**。出力は `Voucher.ocrJson` に書き込み、spec 12 の突合（金額 + 日付）で使う。

## ゴール

1. POST /api/vouchers で画像が保存されたら、サーバ内で **fire-and-forget** で OCR を起動する（クライアントは待たない）
2. 画像 1 枚 → 5 フィールド（issue_date / vendor_name / addressee / amount / invoice_number）の JSON を抽出
3. 抽出結果と進行状況（pending / processing / done / failed）を UI から確認できる
4. 失敗した場合に手動で再試行できる
5. テスト時に OpenAI を叩かない（決定論的 / 無料）

## アクター

- **税理士事務所スタッフ**: アップロード後の OCR 結果を確認する
- **zeimee サーバ**: OpenAI Vision API を呼び出すクライアント

## トリガー

| パターン | 仕様 |
|---|---|
| 自動（メイン） | POST /api/vouchers 成功直後にサーバ内 `setImmediate` で OCR をキック。HTTP レスポンスは 201 を即返す |
| 手動（再試行） | POST /api/vouchers/:id/ocr — 1 件再実行（既存 ocrJson は上書き） |

非同期実装はキュー等は使わず、ローカルプロセス内の `Promise` で十分。プロトタイプなので、サーバ再起動中に消えるリスクは許容する。

## データモデル拡張

`Voucher.ocrStatus` は spec 10 で既に `String @default("pending")`。

```
pending     初期状態（OCR 未起動）
processing  OCR 実行中
done        成功（ocrJson に結果）
failed      失敗（ocrError にメッセージ）
```

新規追加:

```prisma
model Voucher {
  // ... 既存フィールド
  ocrError String?       // failed 時のエラーメッセージ（cause を 1 行で）
}
```

`ocrJson` は spec 10 で既に `Json?`。スキーマ:

```ts
{
  issue_date: string | null,      // "YYYY-MM-DD"。読めなければ null
  vendor_name: string | null,     // 発行者（領収書を切った側）
  addressee: string | null,       // 宛名（領収書を受け取った側）
  amount: number | null,          // 税込合計（円）
  invoice_number: string | null,  // インボイス登録番号 (T で始まる13桁)
}
```

## OCR サービス（`src/services/ocr-service.ts`）

```ts
export interface ExtractedFields {
  issue_date: string | null;
  vendor_name: string | null;
  addressee: string | null;
  amount: number | null;
  invoice_number: string | null;
}

export async function extractVoucherFields(
  imageData: Buffer,
  mimeType: string,
): Promise<ExtractedFields>;
```

実装:
- OpenAI SDK (`openai` パッケージ) の `chat.completions.create` を呼ぶ
- `response_format: { type: 'json_schema', json_schema: { ... } }` で JSON 強制
- `messages[].content` に `{type: 'image_url', image_url: { url: 'data:<mime>;base64,<...>' }}` で画像を埋め込む
- システムプロンプトで「日本語の領収書/請求書から指定 5 項目を抽出。読めない項目は null」を指示
- レスポンスを `JSON.parse` → スキーマで `zod` validate → 返す

エラー時は throw。呼び出し側で catch して `ocrStatus = 'failed'`、`ocrError` にメッセージ。

## OCR ランナー（voucher-service の拡張）

```ts
export async function runOcrForVoucher(id: string): Promise<void>;
```

- 該当 Voucher を取り出し
- `ocrStatus = 'processing'` に更新
- `extractVoucherFields(imageData, mimeType)` を await
- 成功: `ocrStatus = 'done'`, `ocrJson = result`, `ocrAt = now`, `ocrError = null`
- 失敗: `ocrStatus = 'failed'`, `ocrError = err.message`, `ocrAt = now`

POST /api/vouchers のハンドラ末尾で `setImmediate(() => { runOcrForVoucher(meta.id).catch(() => {}); })`。テスト時はこの自動起動を抑止する（後述）。

## ルート追加

| メソッド | パス | 役割 |
|---|---|---|
| POST | `/api/vouchers/:id/ocr` | OCR 再実行。即座に 202 を返し、`runOcrForVoucher` を fire |

レスポンス: `{ ok: true }`（202 Accepted）。未存在は 404 NOT_FOUND。

GET /api/vouchers の戻り値に `ocrJson` / `ocrError` / `ocrAt` を含める（spec 10 では `ocrStatus` のみ返していた）。

## 環境変数

```
OPENAI_API_KEY=sk-...
OPENAI_VISION_MODEL=gpt-4o   # デフォルト。env で gpt-5 等に差し替え可能
```

`OPENAI_API_KEY` 未設定時は **OCR を起動しない**（POST は成功するが ocrStatus は pending のまま、`ocrError = "OPENAI_API_KEY is not set"` を即時セット）。テスト環境はこれで保護される。

env.ts に追加:

```ts
OPENAI_API_KEY: z.string().optional(),
OPENAI_VISION_MODEL: z.string().default('gpt-4o'),
```

## フロント変更

### サムネカードに OCR ステータス + 抽出フィールドを表示

```
+--------------------+
| [thumbnail]    [×] |
+--------------------+
| IMG_0421.jpg       |
| 2026-05-18 14:06   |
+--------------------+
| 📄 ¥3,200          |
| 青山デザイン        |
| 2026-05-15         |
+--------------------+
```

ステータス別の表示:
- `pending` / `processing`: 「OCR 中…」スピナー
- `done`: 上図のように金額・発行者・日付を表示
- `failed`: 「OCR 失敗 [再試行]」赤地表示

### ポーリング

OCR 中のカードがある間、5 秒間隔で `loadVouchers()` を再実行。完了したら停止。

### 再試行ボタン

`data-voucher-retry-ocr` でクリック → `POST /api/vouchers/:id/ocr` → loadVouchers。

## テスト方針

- `OPENAI_API_KEY` が未設定の test env では OCR 自動起動が走らない（pending のまま）→ 既存テスト互換
- `ocr-service.test.ts` は **OpenAI SDK の `chat.completions.create` を vi.spyOn** して固定レスポンスを返させる（OpenAI は spec 10 でいう「ベンダー API」ではないので mock 可）
- `voucher-service.test.ts` に `runOcrForVoucher` のテストを追加（OpenAI SDK は spy）
- `routes/vouchers.test.ts` に POST /:id/ocr のテスト（202 + 404）
- 既存 POST /api/vouchers テストは引き続き通る（API_KEY 未設定で起動しないため）

## 受入基準

- [ ] `OPENAI_API_KEY` を `.env` に設定 + サーバ再起動で OCR が自動で走る
- [ ] アップロード直後はサムネに「OCR 中…」が出て、数秒後にリロード（または自動ポーリング）で抽出結果が表示される
- [ ] 抽出結果に金額・発行者・日付が出る
- [ ] OCR 失敗時に「失敗 [再試行]」ボタンが出て、押すと再試行する
- [ ] `OPENAI_API_KEY` 未設定だとアップロードは成功するが `ocrStatus = pending`（または failed）のまま
- [ ] 既存 vitest スイートが PASS

## 非ゴール

- 抽出結果と MF 仕訳の突合（spec 12）
- 抽出結果ビューの一覧テーブル（spec 12 / 13）
- バルク OCR 再試行ボタン
- レート制限・コスト制御（プロトタイプ）
