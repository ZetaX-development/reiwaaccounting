# 12. 証憑 × MF 仕訳 突合（顧問先 AI 推測 + 突合エンジン）

作成日: 2026-05-19

## 位置づけ

spec 11 で OCR された Voucher（金額・日付・宛名等）を、A→B→C→D の **C** として、

1. 顧問先（clientId）が未割当ての voucher は **AI で推測して自動振り分け**
2. 顧問先が決まったら、その顧問先の **MF 仕訳（live fetch）と金額完全一致 + 日付 ±30日 で突合**
3. 結果を `Voucher.matchedEntryId` / `matchStatus` に書き戻す

spec 13 (突合結果ビュー) で UI 一覧画面を出すが、本スペックでも証憑登録カードに突合バッジを出すところまで含める。

## ゴール

1. OCR 成功 → サーバ内で自動的に顧問先推測 + 突合まで走り切る（ユーザ操作不要）
2. 推測の根拠を残す（`matchedClientReason`）
3. 推測が外れたケース、突合できなかったケースで手動再試行ができる
4. **MF 仕訳は live fetch、DB にキャッシュしない**（既存方針）

## アクター

- **税理士事務所スタッフ**: 突合バッジを見て突合結果を確認、必要なら手動で顧問先変更
- **bookmee サーバ**: OpenAI + MF API を呼ぶ

## トリガー

| パターン | 動作 |
|---|---|
| 自動（メイン） | `runOcrForVoucher` が done に遷移した直後、サーバ内で `assignAndMatchVoucher` を非同期実行 |
| 手動（顧問先変更） | フロントから PATCH /api/vouchers/:id で clientId を上書き → 即時再突合 |
| 手動（再突合のみ） | POST /api/vouchers/:id/match — clientId が既に正しい前提で MF と再突合 |

## データモデル拡張

`Voucher.matchedEntryId` / `matchStatus` は spec 10 で既に追加済み。追加が必要なフィールド:

```prisma
model Voucher {
  // ... 既存
  matchedAt           DateTime?   // 突合実行時刻
  matchedClientReason String?     // 顧問先推測の根拠 ("addressee", "ai", "manual" のいずれか)
}
```

`matchStatus` の取り得る値:

```
unmatched   突合未実行 or 一致なし（初期値）
matched     1 件マッチ（matchedEntryId にセット）
no_client   顧問先未割当てのため突合不可
no_data     OCR の金額 or 日付が抽出できず突合不可
```

## 顧問先推測アルゴリズム

`services/voucher-assign-service.ts` に実装:

```ts
export async function assignVoucherToClient(
  voucherId: string,
): Promise<{ clientId: string | null; reason: string }>;
```

ステップ:

1. Voucher を取り出す（OCR 完了済みであること）
2. `ocrJson.addressee` が顧問先名（または name の部分一致）と一致 → そのクライアントに割当 (`reason: 'addressee'`)
3. 上記でヒットしない → OpenAI に
   - 入力: vendor_name / addressee / amount / 顧問先一覧 (id, name, industry)
   - 指示: 「この領収書を経費で計上する可能性が最も高い顧問先を 1 つ選んで `clientId` を返す。不明なら null」
   - モデル: `OPENAI_VISION_MODEL` と同じ（GPT-5 / コンテキスト軽いので速い）
   - JSON schema 強制
4. `reason: 'ai'` でセット。null なら未割当て据え置き

部分一致は `addressee.includes(client.name)` または `client.name.includes(addressee)`（短すぎる name は除外、3 文字未満は無視）。

## 突合アルゴリズム

`services/matching-service.ts`:

```ts
export interface MatchResult {
  status: 'matched' | 'unmatched' | 'no_client' | 'no_data';
  matchedEntryId: string | null;
}

export async function findMatchForVoucher(
  voucherId: string,
): Promise<MatchResult>;
```

ステップ:

1. Voucher を取り出す
2. `clientId` が null → `{ status: 'no_client', matchedEntryId: null }`
3. `ocrJson.amount` または `ocrJson.issue_date` が null → `{ status: 'no_data' }`
4. `getLiveMfEntries(clientId)` で MF から仕訳を **live fetch**（既存 client-service の関数を利用）
5. 候補 = `entries.filter(e => e.amount === voucher.amount && abs(daysBetween(e.date, voucher.issue_date)) <= 30)`
6. 候補が 0 件 → `unmatched`
7. 候補から **日付差の絶対値が最小のもの** を 1 件選択 → `matched`

複数候補がある場合の cardinality は「最も近い日付」固定。matchedEntryId は MF の `externalId`（既存 Entry テーブルでも使ってる文字列キー）を保存。

## ランナー: assignAndMatchVoucher

`voucher-service.ts` に追加:

```ts
export async function assignAndMatchVoucher(voucherId: string): Promise<void>;
```

- 該当 voucher を読む
- clientId が null かつ ocrStatus == 'done' の場合のみ assignVoucherToClient を呼ぶ
- findMatchForVoucher を呼ぶ
- 結果を Voucher に保存（clientId, matchedClientReason, matchedEntryId, matchStatus, matchedAt）

`runOcrForVoucher` の done 遷移直後に `setImmediate(() => assignAndMatchVoucher(id))` でキック。

## API

### 既存 GET /api/vouchers 拡張

レスポンスに以下を追加:

```ts
{
  // ... 既存
  matchedEntryId: string | null,
  matchStatus: string,
  matchedAt: string | null,
  matchedClientReason: string | null,
  matchedEntry: {  // matched の場合のみ
    externalId: string,
    description: string,
    amount: number,
    issueDate: string,  // YYYY-MM-DD
  } | null,
}
```

`matchedEntry` は live fetch でその場で MF API を叩いて埋める。複数 voucher が同じ entry を参照する N:1 を許容（spec 10 で議論済み）。

### 新規 PATCH /api/vouchers/:id

```
PATCH /api/vouchers/:id
Body: { clientId: string | null }
```

顧問先を手動で更新。更新後にサーバ内で `findMatchForVoucher` を再実行（`matchedClientReason = 'manual'`）。

### 新規 POST /api/vouchers/:id/match

手動再突合（顧問先は変えない）。202 を返して setImmediate で `findMatchForVoucher`。

## フロント変更

### カードに突合バッジを追加（OCR 結果の下）

```
🔗 ✓ 仕訳と突合 (¥2,400 / 2026-05-15 / 雑費)
   または
🔗 MF 仕訳と一致なし [再突合]
   または
🔗 顧問先未割当て
   または
🔗 OCR データ不足
```

色:
- matched: 緑
- unmatched: 黄
- no_client / no_data: 灰

### 顧問先タブへの D&D（手動再割当て）

サムネを別の顧問先タブにドラッグ → drop で PATCH /api/vouchers/:id を発行 → loadVouchers。

D&D の visual feedback: drop 可能タブを hover で強調。

## テスト方針

- `matching-service.test.ts`: 突合ロジックの単体テスト。MF API は spy で固定エントリを返す
- `voucher-assign-service.test.ts`: 顧問先推測。OpenAI は spy
- `routes/vouchers.test.ts` に PATCH /:id と POST /:id/match のテスト追加（5 ケース程度）
- 既存テスト互換: `OPENAI_API_KEY` 未設定では automatic な assign+match はスキップ（pending のまま）

## 受入基準

- [ ] OCR 完了済みかつ未割当て voucher を新規アップロード → 数秒後に自動で顧問先割当て + MF 仕訳との突合まで完了
- [ ] addressee が顧問先名に部分一致した場合は `matchedClientReason: 'addressee'`
- [ ] そうでない場合は AI 推測で `matchedClientReason: 'ai'`
- [ ] 金額一致 + 日付 ±30日 で MF 仕訳が見つかれば matched、緑バッジ + 仕訳概要が表示される
- [ ] OPENAI_API_KEY 未設定だと自動割当て・突合は走らないが、PATCH で手動割当て後の突合は動く（OpenAI 不要）
- [ ] サムネを別タブに D&D → 顧問先変更 + 再突合

## 非ゴール

- 「突合結果一覧」サイドバービュー（spec 13）
- 突合済みの中で重複（同じ entry を複数 voucher が指す）の警告
- 顧問先推測の confidence score の UI 表示
- MF へ突合済み紐付けを書き戻す（read-only ポリシー、書き戻し禁止）
