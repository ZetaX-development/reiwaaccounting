# 10. 証憑登録（アップロードUI + ストレージ）

作成日: 2026-05-18

## 位置づけ

ユーザ要望: 「領収書やレシートなどの証憑を入れまくれる UI」を作り、その後 OpenAI Vision で項目抽出 (spec 11) → MF 仕訳との突合 (spec 12) → 突合結果ビュー (spec 13) に繋げる、その第一段。

本スペックは A→B→C→D の **A** に該当し、**ファイルを受け取って保管し、一覧表示する** ところまでがスコープ。OCR・自動振り分け・突合は spec 11 以降。

### 既存スペックとの関係

spec 07 (証憑不足の自動検出) と spec 08 (機能重複回避) には以下の方針が書かれている:

- spec 07 スコープ外: 「実OCRによる証憑自動添付」「証憑のスキャン・PDFパーサ」「顧問先ポータルからのアップロード受付」
- spec 08 O2: 「freeeやMFが既に持っている機能（OCR・帳票自動仕訳・電子帳簿保存対応の証憑保管）は bookmee で再実装しない」

**本スペックはこの方針を一部書き換える**。具体的には spec 10–13 系列で「OCR と証憑保管」を bookmee 側に持つ。理由は、MF の証憑保管は仕訳に紐づいた既存証憑が対象であり、「**仕訳化される前の散らかった証憑**を集めて事務所側で交通整理する」用途は既存ベンダーが弱いから。スタッフが「入れまくれるバケツ」+ AI 自動振り分けというワークフローは bookmee 独自価値として成立する。

spec 07 の「手動添付UIは作らない」も同様に再考の対象。spec 07 では「freee/MF で証憑を見るジャンプリンク」に置換していたが、spec 10-13 完成後は「bookmee 側でアップロード → 自動紐付け → 不足を埋める」フローに進化させる。詳細は spec 13 で扱う。

## ゴール

1. スタッフが画像をドラッグ&ドロップで一括アップロードできる
2. 顧問先を選ばずに入れた証憑は「未分類」プールに保管される
3. 未分類 / 顧問先別のサムネ一覧で何が登録済みか一目で見える
4. 誤投入したものは削除できる
5. データモデルが spec 11 (OCR) / spec 12 (突合) の拡張に耐える形になっている

## アクター

- **税理士事務所スタッフ**（bookmee 内部ユーザ）: アップロード操作の主体
- 顧問先側のアップロード受付は本スペックではスコープ外

## 入力仕様

| 項目 | 許可 | 非許可 |
|---|---|---|
| 画像形式 | JPG / PNG / GIF / WebP | HEIC（変換コスト過大のため除外） |
| PDF | spec 10 では非対応で MIME チェックで弾く | — |
| ファイルサイズ | 10MB 以下 | 10MB 超 |
| 入力方法 | ドラッグ&ドロップ + ファイル選択ダイアログ | — |

**PDF への将来対応メモ**: 文字埋め込み PDF は画像変換不要で `pdf-parse` 等によるテキスト抽出が可能。画像 PDF はページ画像化が必要。spec 11 以降で例外処理として導入する。

## データモデル

新規 Prisma モデル `Voucher` を追加。`Receipt`（MF/freee 由来）とは別物として明確に分離する。

```prisma
model Voucher {
  id         String   @id @default(cuid())
  client     Client?  @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId   String?              // null = 未分類プール
  filename   String               // オリジナル名（"IMG_0421.jpg" 等、診断用）
  mimeType   String               // "image/jpeg" / "image/png" etc
  size       Int                  // バイト数
  imageData  Bytes                // BYTEA 本体
  uploadedAt DateTime @default(now())
  uploadedBy String?              // 現状は role 切替の文字列 ("所長" / "スタッフ") を保存

  // 以下は spec 11/12 で書き込む。spec 10 ではすべて null / 既定値のまま
  ocrJson        Json?
  ocrStatus      String   @default("pending")     // pending | done | failed | skipped
  ocrAt          DateTime?
  matchedEntryId String?                          // unique 制約なし。複数 Voucher が同じ Entry を指せる
  matchStatus    String   @default("unmatched")   // unmatched | matched | multi-candidate | rejected

  @@index([clientId, uploadedAt])
  @@index([ocrStatus])
}
```

`Client` 側に `vouchers Voucher[]` リレーションを追加。

### なぜ BYTEA か

選択肢としてローカル fs / Postgres BYTEA / S3 互換を検討したうえで BYTEA を採用。

- 単一 DB ダンプで証憑も含めてバックアップ可能
- アプリ側でファイル路の同期 / 削除順序の整合性を考えなくて良い
- プロトタイプ規模（数百〜数千枚）なら Postgres の肥大化は許容範囲
- 本番化時に S3 互換へ移行する場合、`imageData` を `storageRef: String` に置換するスキーマ変更だけで済む

### なぜ spec 11/12 用フィールドを先取りするか

マイグレーションを 1 回で済ませるため。spec 10 では `ocrStatus: 'pending'` / `matchStatus: 'unmatched'` で固定保存しておく。spec 11 が来たら OCR ジョブが `ocrJson` / `ocrStatus` を更新、spec 12 が `matchedEntryId` / `matchStatus` を更新する。

### Entry との結合方法

`Voucher.matchedEntryId` は **外部キーではなく文字列**。理由は MF 仕訳が live fetch（DB にキャッシュしない方針）であり、`Entry` テーブルとは独立だから。`matchedEntryId` には MF API の sourceEntryId 由来の値（`live-mf-<sourceEntryId>`）または DB Entry の id を文字列として格納する。

カーディナリティは N : 1（複数 Voucher → 1 Entry）を許容する。よって `matchedEntryId` に unique 制約はかけない。同額複数枚（例: 交際費 ¥8,800 の仕訳に「店のレシート」「Suica チャージ」「同行者メール」を全部紐付け）を想定。spec 12 のアルゴリズムは各 Voucher の金額 = Entry の金額を必須とし、合計マッチ（分割支払い）はスコープ外とする。

## API

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/api/vouchers` | 1 ファイルアップロード |
| `GET` | `/api/vouchers` | 一覧（メタのみ、`imageData` は含まない） |
| `GET` | `/api/vouchers/:id/image` | 画像本体をストリーミング配信 |
| `DELETE` | `/api/vouchers/:id` | 1 件削除 |

### POST /api/vouchers

multipart/form-data:
- `file`: 必須、画像バイナリ
- `clientId`: 任意、省略で未分類

ヘッダ:
- `X-Uploaded-By`: 任意、フロントの role 切替値（"所長" / "スタッフ" 等）

レスポンス（201）:
```json
{
  "id": "ck...",
  "clientId": "aoyama-design",
  "filename": "IMG_0421.jpg",
  "mimeType": "image/jpeg",
  "size": 342108,
  "uploadedAt": "2026-05-18T05:32:00.000Z",
  "uploadedBy": "スタッフ",
  "ocrStatus": "pending",
  "matchStatus": "unmatched"
}
```

エラー:
- `400 INVALID_MIME` (HEIC / PDF / その他非対応)
- `400 FILE_TOO_LARGE` (10MB 超)
- `400 INVALID_BODY` (file フィールド欠落)
- `404 CLIENT_NOT_FOUND` (clientId 指定でクライアント存在しない)

### GET /api/vouchers

クエリ:
- `clientId=<cuid>` 顧問先指定
- `clientId=unassigned` 未分類のみ
- `clientId` 省略 全件

レスポンス: 上記 POST と同形の配列（`imageData` は含まない）。`uploadedAt DESC` 順。

### GET /api/vouchers/:id/image

レスポンス: 画像バイナリそのまま。
- `Content-Type`: 保存時の mimeType
- `Cache-Control: private, max-age=300` （削除後のキャッシュ残留を抑える短めの TTL）
- 404 なら `{ error: { code: "NOT_FOUND" } }`

### DELETE /api/vouchers/:id

レスポンス（200）: `{ ok: true }`、404 なら `NOT_FOUND`。

## サーバ側構成

**新規ファイル**:
- `server/src/routes/vouchers.ts` — 4 エンドポイント
- `server/src/services/voucher-service.ts` — `createVoucher` / `listVouchers` / `getVoucherImage` / `deleteVoucher`

**既存ファイル変更**:
- `server/src/server.ts` — `voucherRoutes` を `register`
- `server/prisma/schema.prisma` — `Voucher` モデル追加、`Client.vouchers` 追加
- `server/package.json` — `@fastify/multipart` 追加

**依存追加**:
- `@fastify/multipart`（multipart/form-data ハンドリング）

**設定**:
- `.env.example` は変更なし（外部 API 連携が無いため）
- multipart の上限は `@fastify/multipart` の `limits.fileSize: 10 * 1024 * 1024`

### voucher-service.ts シグネチャ

```ts
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

export async function createVoucher(input: {
  clientId: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy: string | null;
}): Promise<VoucherMeta>;

export async function listVouchers(filter: {
  clientId: string | 'unassigned' | null;  // null = 全件
}): Promise<VoucherMeta[]>;

export async function getVoucherImage(id: string): Promise<{
  mimeType: string;
  data: Buffer;
} | null>;

export async function deleteVoucher(id: string): Promise<boolean>;
```

「live fetch over cache」原則との関係: Voucher は bookmee オーナーのデータなので DB 保存して読み返してOK。MF/freee 由来データだけがライブ取得対象、というメモリ既存ルールの範囲外。

## フロント構成

`data-view="vouchers-register"` の空ビュー（既に index.html / script.js に追加済み）を実装に差し替える。レイアウトは A 案（上ドロップゾーン + 下タブ + 下サムネ）。

### index.html
変更なし。全 DOM を `renderVoucherRegister()` 内で生成。

### script.js 追加関数

| 関数 | 役割 |
|---|---|
| `loadVouchers(filter)` | `GET /api/vouchers?clientId=...` を叩き `appState.vouchers` に格納 |
| `uploadVouchers(files)` | `File[]` を並列 POST。`appState.uploadQueue` に各ファイルの進捗 push |
| `deleteVoucherById(id)` | `DELETE /api/vouchers/:id` → 一覧再取得 |
| `renderVoucherRegister()` | 全 DOM 生成（3 ブロック構成） |

### appState 追加

```js
vouchers: [],                  // 現タブで表示中のメタ一覧
voucherTab: 'unassigned',      // 'unassigned' | <clientId>
voucherCounts: {},             // { unassigned: 12, 'aoyama-design': 8, ... }
uploadQueue: [],               // [{ tempId, filename, progress, status }]
```

### 3 ブロック

1. **ドロップゾーン**（`.voucher-dropzone`）
   - 「画像をここにドロップ または [ファイルを選択]」
   - `dragover` / `drop` でファイル受信、`<input type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp">` も同居
   - 受信した瞬間に `uploadQueue` に積み、並列 POST。完了したら `loadVouchers` 再実行
   - HEIC / PDF / 容量超過は client 側で先に弾いてトースト

2. **タブ行**（`.voucher-tabs`）
   - 最左に `未分類 N`、その後ろに Voucher を持つ顧問先を件数降順で並べる
   - クリックで `voucherTab` 切替 → 一覧再取得
   - 件数は `voucherCounts` から表示

3. **サムネ一覧**（`.voucher-grid`）
   - 6 列 grid
   - 各カード: `<img src="/api/vouchers/:id/image">` + 下部小さく「IMG_0421.jpg / 2026-05-18 14:32」
   - ホバーで右上に削除ボタン（赤 ×）
   - クリックで原寸モーダル

### アップロード中の見せ方

- サムネ一覧の先頭に「アップロード中」プレースホルダ（spinner + filename）を `uploadQueue` の中身ぶん表示
- 完了したら本物のサムネに置き換わる
- 失敗したら赤枠 + 「失敗」、クリックで再試行

### renderView 組み込み

```js
"vouchers-register": () => renderVoucherRegister(),
```
`if (appState.activeView === "vouchers-register") { loadVouchers({ clientId: appState.voucherTab }); }`

`labels` / `labels.helper` も「証憑登録」用のエントリに更新（既存の placeholder を実機文言に差し替え）。

### styles.css

`.voucher-dropzone`, `.voucher-tabs`, `.voucher-grid`, `.voucher-card`, `.voucher-card.uploading`, `.voucher-card-actions` などのクラスを追加。既存のトークン（border-radius, color など）に合わせる。

### uploadedBy の取り扱い

既存 `roleSelector` の value（"所長" / "スタッフ"）を `X-Uploaded-By` ヘッダで送り、サーバが `Voucher.uploadedBy` に保存。認証実装は本スペックの範囲外。

## エラー処理

| ケース | 挙動 |
|---|---|
| HEIC / PDF / その他非対応 MIME | フロントで先に弾き「対応していない形式です」トースト |
| 10MB 超 | フロントで弾き「ファイルが大きすぎます」トースト |
| アップロード中のネット切断 | `uploadQueue` を `failed` 状態、クリックで再試行 |
| Postgres 接続断 | 500 → フロント「保存できませんでした」トースト |
| 削除しようとした Voucher が他で参照中 | spec 10 では参照無いので考慮不要（spec 12 で `matchedEntryId` 影響を扱う） |
| 巨大画像 (例: 8000x6000) | 原寸保存・原寸配信。ブラウザ側のリサイズに任せる |

## テスト

既存方針（vitest + 実 Postgres、モック無し）を踏襲。

- `tests/services/voucher-service.test.ts` — 6 ケース
  - createVoucher が `imageData` を含む行を作る
  - listVouchers の clientId フィルタ 3 ケース（cuid / 'unassigned' / null）
  - getVoucherImage が mimeType + Buffer を返す
  - deleteVoucher で行が消える
- `tests/routes/vouchers.test.ts` — 5 ケース
  - `POST /api/vouchers` 許可 MIME → 201
  - `POST /api/vouchers` 拒否 MIME → 400 INVALID_MIME
  - `POST /api/vouchers` サイズ超過 → 400 FILE_TOO_LARGE
  - `GET /api/vouchers/:id/image` の Content-Type
  - `DELETE /api/vouchers/:id` の 404
- フロント側テストは現状この repo に基盤が無いので作らない（手動確認）

## 受入基準

- [ ] `npm run prisma:migrate` で `Voucher` テーブルが作られる
- [ ] `POST /api/vouchers` で multipart 画像が DB に保存される (JPG/PNG/GIF/WebP)
- [ ] HEIC / PDF / 11MB 以上は 400 で拒否
- [ ] `GET /api/vouchers?clientId=unassigned` で未分類のみ返る
- [ ] `GET /api/vouchers?clientId=<cuid>` で特定顧問先の Voucher が返る
- [ ] `GET /api/vouchers/:id/image` で原寸画像が `Content-Type` 付きで返る
- [ ] `DELETE /api/vouchers/:id` で削除できる
- [ ] フロント「証憑登録」ビューでドラッグ&ドロップで複数ファイルがアップロードできる
- [ ] アップロード中のプレースホルダが見える
- [ ] タブ切替で未分類 / 各顧問先のサムネが見える
- [ ] サムネクリックで原寸モーダルが開く
- [ ] サムネホバーで削除ボタンが出て削除できる
- [ ] サーバ側テスト 11 ケースが通る（voucher-service 6 + vouchers route 5）

## スコープ外（spec 11+ で扱う）

- OpenAI Vision による項目抽出（spec 11）
- 抽出した宛名による顧問先自動振り分け（spec 11）
- MF 仕訳との突合エンジン（spec 12）
- 突合結果ビュー（spec 13）
- サムネのリサイズ・WebP 変換
- 重複検出（同一画像ハッシュ判定）
- 顧問先側からのアップロード受付（顧問先ポータル）
- 認証・権限制御

## 突合アルゴリズム（spec 12 用のメモ、本スペックでは実装しない）

spec 10 のデータモデルが下記アルゴリズムに耐える形になっていることを確認するためのメモ:

```
for each MF entry E in (live fetch):
  candidates = Vouchers WHERE
      voucher.clientId == E.clientId
      AND voucher.matchStatus IN ('unmatched', 'matched')
      AND voucher.ocrJson.amount == E.amount
      AND |voucher.ocrJson.date - E.occurredAt| <= 30 days

  if 0 candidates: skip
  if 1 candidate: voucher.matchedEntryId = E.id, matchStatus = 'matched'
  if N candidates: score each by dateProximity + vendorSimilarity + invoiceExact
                   if top1 - top2 >= AMBIGUITY_THRESHOLD: top1 を確定
                   else: top1..N すべて matchStatus = 'multi-candidate'

# 同額複数枚を許す（N : 1）。スコープ外: 合計マッチ・分割。
```

抽出は OpenAI Vision `response_format: json_schema` で {date, vendorName, payee, amount, invoiceNumber, confidence} を強制取得。
