# 13. 証憑入力チャネル拡張 — Google Drive 連携（基盤）

作成日: 2026-05-19

## 位置づけ

ユーザ要望: ファイルアップロード経路を増やしたい。Google Drive、LINE、メール転送など。

本スペックは「**スタッフ側**が **事務所共通の 1 つの Google Drive アカウント** に置いたレシート画像を、zeimee が自動取り込みする経路」を作る。LINE 経由（spec 14）とメール転送（spec 15）は後続スペックに分けるが、本スペックで作る `Integration` テーブルや `Voucher.source` 列はそれらにも流用できる汎用形で設計する。

### 既存スペックとの関係

- spec 10（証憑登録 UI）: 手動アップロード `POST /api/vouchers` を実装済み。**本スペックは spec 10 の Voucher パイプラインの "前段に Drive 取り込みを追加するだけ"** で、Voucher 作成以降（OCR/振り分け/突合）は変更しない。
- spec 11（OCR）/ spec 12（突合）: 本スペックで作った Voucher も同じ流れに乗る。Drive 由来かどうかを意識しない。
- spec 10 はスコープ外として「顧問先側からのアップロード受付（顧問先ポータル）」を明記していた。本スペックは **スタッフ運用の Drive 共有** という別ベクトルなので、その方針と矛盾しない。

### MF/freee の read-only 原則との関係

CLAUDE.md と spec 08 に書かれた「MF/freee は read-only」の原則は **MF/freee に対してのみ** の話。Google Drive は事務所スタッフが管理するストレージなので、本スペックで Drive の `files.update`（取り込み済フォルダへの move）を行う。誤動作のリスクを減らすため、move 操作は「取り込みに成功した Voucher」に対してのみ、「同一 Drive アカウント内の指定サブフォルダへの移動」だけに限定する。削除や上書きはしない。

## ゴール

1. Google アカウント 1 つを zeimee に OAuth で繋ぐ
2. Drive のルートフォルダ配下のサブフォルダを zeimee 上で顧問先と手動 mapping する
3. mapping されたサブフォルダに置かれた画像を自動取り込み（本番は Push Notification、開発は「今すぐ同期」ボタン）
4. 取り込んだファイルは Drive 上で「取り込み済」サブフォルダに move する
5. 取り込んだ Voucher は spec 11 の OCR、spec 12 の突合パイプラインにそのまま乗る（追加実装なし）
6. 二重取り込みは `Voucher.driveFileId` の unique で防止される

## アクター

- **税理士事務所スタッフ**: 自分の業務用 Drive にレシートを放り込む / zeimee 上で接続・mapping・同期を管理する
- 顧問先側のアップロードは本スペックではスコープ外（spec 14/15 で別経路）

## 全体フロー

```
[スタッフが Drive にレシート画像を入れる]
        │
        ├── 本番: Drive Push Notification → POST /api/integrations/drive/webhook
        └── 開発: 「今すぐ同期」ボタン       → POST /api/integrations/drive/sync
                                              │
                                              ▼
                              drive-importer.syncDriveChanges()
                              changes.list で差分 → 各ファイル処理
                                              │
                                              ▼
              files.get(alt=media) でバイナリ取得（最大 10MB）
                                              │
                                              ▼
              voucher-service.createVoucher(...) → 取得 Voucher を update で
              source='drive' / driveFileId=file.id / driveImportStatus='imported'
                                              │
                                              ▼
              files.update で Drive 上を「取り込み済」サブフォルダに move
              （失敗時は Voucher は残し driveImportStatus='move_failed'）
                                              │
                                              ▼
              既存 spec 11 OCR ジョブ → 既存 spec 12 突合（本 spec では触らない）
```

## データモデル

### 新規モデル

```prisma
model Integration {
  id        String   @id @default(cuid())
  type      String   // 'google_drive'（将来: 'line', 'email'）
  creds     Json     // Drive の場合: { accessToken, refreshToken, expiresAt, scope, email }
  settings  Json     @default("{}")  // Drive の場合: { rootFolderId, rootFolderName, importedSubfolderName }
  enabled   Boolean  @default(true)
  status    String   @default("ok")  // 'ok' | 'reauth_required' | 'watch_failed'
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([type])   // 1 種別 1 行のシングルトン運用（事務所 1 アカウント方針）
}

model DriveFolderMapping {
  id            String   @id @default(cuid())
  driveFolderId String   @unique
  folderName    String                       // 表示用キャッシュ
  importedSubfolderId String?                // 「取り込み済」サブフォルダ ID、無ければ初回 sync で作成
  client        Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId      String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([clientId])
}

model DriveWatchChannel {
  id          String   @id @default(cuid())
  channelId   String   @unique               // 自前で発行する UUID
  resourceId  String                         // Google が返す resource id
  pageToken   String                         // 次回 changes.list 用
  expiresAt   DateTime
  createdAt   DateTime @default(now())
}
```

### 既存 Voucher への追加列

```prisma
// 既存 Voucher に追加
source            String   @default("manual")  // 'manual' | 'drive'
driveFileId       String?  @unique             // Drive 由来のときセット、unique で重複防止
driveImportStatus String?                       // null | 'imported' | 'move_failed'
```

### 既存 Client への追加リレーション

```prisma
driveFolderMappings  DriveFolderMapping[]
```

### 設計上の決定理由

- **Integration を 1 種別 1 行のシングルトンに**: ユーザ要件が「Drive アカウントは 1 つ」なので、複数行を許す必要がない。`@@unique([type])` で強制。
- **`creds` を Json**: アクセストークン形式が種別ごとに違うので柔軟に。Postgres BYTEA で暗号化…は本 spec ではやらない（プロトタイプ規模、Drive スコープが事務所運用に閉じる）。
- **「取り込み済」サブフォルダを各顧問先フォルダ直下に作る**: ルート直下に 1 つだと「どの顧問先のレシートか」が Drive 上から見えなくなる。各顧問先フォルダ配下にすることで Drive 上でも人間が辿れる。
- **`driveFileId` を unique**: webhook 多重発火・手動 sync ボタン連打・watch renew 後の再 sync などで同じファイルが二度走っても、DB レベルで弾ける（冪等性）。
- **Voucher 作成は既存 `voucher-service.createVoucher` を使い、Drive 固有列は後追い update**: spec 10 の API を触らない。Drive 固有のフィールドは drive-importer が単独で update する。

## API

| Method | Path | 用途 |
|---|---|---|
| `GET`    | `/api/integrations/drive` | 接続状態（接続済 / 未接続、email、status、watch expiresAt） |
| `GET`    | `/api/integrations/drive/oauth/authorize` | Google OAuth 認可へリダイレクト |
| `GET`    | `/api/integrations/drive/oauth/callback` | code → token 交換、Integration 行作成 |
| `DELETE` | `/api/integrations/drive` | 切断（トークン削除、watch 停止） |
| `GET`    | `/api/integrations/drive/folders` | 設定中ルート配下のサブフォルダ一覧（mapping UI 用） |
| `GET`    | `/api/integrations/drive/mappings` | DriveFolderMapping 一覧 |
| `POST`   | `/api/integrations/drive/mappings` | 1 件作成 `{ driveFolderId, folderName, clientId }` |
| `DELETE` | `/api/integrations/drive/mappings/:id` | 1 件削除 |
| `PUT`    | `/api/integrations/drive/settings` | `{ rootFolderId, importedSubfolderName }` の更新 |
| `POST`   | `/api/integrations/drive/sync` | 手動「今すぐ同期」 |
| `POST`   | `/api/integrations/drive/webhook` | Drive Push Notification 受け口 |
| `POST`   | `/api/integrations/drive/watch/renew` | watch channel の再登録 |

### `/oauth/authorize` と `/oauth/callback`

既存 `server/src/routes/mf-oauth.ts` のパターンを参考にする。Google 側のスコープは:

```
https://www.googleapis.com/auth/drive          # ファイル read + move + 「取り込み済」フォルダ作成
https://www.googleapis.com/auth/userinfo.email # 接続中アカウントのメール取得
```

`drive.readonly` ではなく `drive` を選ぶ理由: move 操作（`addParents` / `removeParents`）と「取り込み済」サブフォルダの自動作成のため。`drive.file` だけだと既存ファイルに触れないので不可。

### `POST /api/integrations/drive/sync` レスポンス例

```json
{
  "trigger": "manual",
  "scanned": 12,
  "imported": 7,
  "skipped": 4,
  "failed": 1,
  "lastPageToken": "abcdef..."
}
```

### `POST /api/integrations/drive/webhook` 検証

- ヘッダ `X-Goog-Channel-ID` を `DriveWatchChannel.channelId` と照合 → 不一致なら 404
- ヘッダ `X-Goog-Resource-State` が `sync`（最初のハンドシェイク）なら no-op で 200
- それ以外の state（`update` / `add` / `change` 等）なら `syncDriveChanges({ trigger: 'webhook' })` を `setImmediate` でキック、即座に 200 を返す（Google は 30 秒以内のレスポンスを要求）

### エラーレスポンス（共通）

既存パターンに揃え `{ error: { code, message } }` 形。
- `400 INVALID_BODY`
- `401 NOT_CONNECTED`（Integration 行が無い / `reauth_required`）
- `404 NOT_FOUND`
- `409 ALREADY_CONNECTED`（接続済の状態で再度 callback が来た）
- `502 DRIVE_API_ERROR`

## サーバ側構成

### 新規ファイル

- `server/src/routes/integrations-drive.ts` — 上記 API 群
- `server/src/services/drive-service.ts` — Google Drive API ラッパ（`listChanges` / `getFileBinary` / `moveFile` / `ensureImportedSubfolder` / `getStartPageToken` / `listSubfolders` / `startWatch` / `stopWatch` / OAuth `exchangeCode` / `refreshAccessToken` / `getUserEmail`）
- `server/src/services/drive-importer.ts` — `syncDriveChanges({ trigger })` 本体
- `server/src/services/integration-service.ts` — Integration 行の CRUD と `ensureDriveToken()`（残り 60 秒以下で refresh、既存 `mf-api.ts:ensureToken` と同様のパターン）

### 既存ファイル変更

- `server/src/server.ts` — `integrationsDriveRoutes` を `register`
- `server/prisma/schema.prisma` — 上述のモデル追加 / Voucher 拡張
- `server/src/env.ts` — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` / `GOOGLE_DRIVE_WEBHOOK_BASE_URL`（optional）を追加
- `server/package.json` — `googleapis` を追加（Drive API クライアント。OAuth と REST 両方を提供する）

### 環境変数

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/integrations/drive/oauth/callback
GOOGLE_DRIVE_WEBHOOK_BASE_URL=    # 例: https://zeimee.example.com 。未設定なら watch を貼らず手動 sync のみで動く
```

`GOOGLE_DRIVE_WEBHOOK_BASE_URL` が未設定の場合、`drive-service.startWatch` は no-op で成功扱いとし、ローカル開発では手動 sync のみで運用できる。

## `drive-importer.syncDriveChanges` の処理

```ts
export async function syncDriveChanges(opts?: { trigger: 'manual' | 'webhook' }): Promise<{
  trigger: 'manual' | 'webhook';
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  lastPageToken: string;
}>;
```

### 処理ステップ

1. `Integration` (type=`google_drive`) を取得。なければ即 return（scanned=0）
2. `ensureDriveToken()` で access token を確保（refresh 失敗時は `Integration.status='reauth_required'` を立てて throw）
3. `DriveWatchChannel.pageToken` を起点に `changes.list` をループ
   - 初回（`DriveWatchChannel` 行が無い）は `getStartPageToken` で取得して保存し、ファイルは取り込まずに終了
4. 各 change で:
   - `file.trashed === true` → skip
   - `file.parents` のどれかが `DriveFolderMapping.driveFolderId` と一致 → 対象。一致しない → skip
   - 既に `Voucher.driveFileId === file.id` が存在 → skip
   - `mimeType` が許可リスト（`image/jpeg` / `image/png` / `image/gif` / `image/webp`）外 → skip
   - `size` が 10MB 超 → skip
5. 対象ファイルの本処理:
   - `files.get(fileId, alt='media')` でバイナリ取得
   - `voucher-service.createVoucher({ clientId: mapping.clientId, filename, mimeType, buffer, uploadedBy: 'drive' })`
   - 作成された Voucher を `prisma.voucher.update` で `source='drive'` / `driveFileId=file.id` / `driveImportStatus='imported'` に更新
   - 当該 mapping の `importedSubfolderId` が無ければ `ensureImportedSubfolder(mapping)` で作成（`Integration.settings.importedSubfolderName` をデフォルト「取り込み済」とする）
   - `moveFile(fileId, addParents=importedSubfolderId, removeParents=mapping.driveFolderId)`
   - move 失敗 → Voucher は残し `driveImportStatus='move_failed'`、failed カウンタ +1
6. ループ終了後、最新の `nextPageToken` を `DriveWatchChannel.pageToken` に保存（途中で個別ファイルが失敗していても `pageToken` は進める。差分ベースの API なので戻すと未処理 change と既処理 change が混ざる）

### 冪等性

- `Voucher.driveFileId` の unique で多重取り込みを防ぐ
- webhook 多重発火・手動 sync 連打・watch renew 後の再 sync が起きても、ファイル単位で skip される
- 並行実行ロックは取らない（取り込み件数が衝突しても DB レベルで弾ける、複雑度に見合わない）

### watch channel

- 接続成功時に `startWatch` で channel 作成（`channelId` は zeimee 側で UUID 発行、address は `${GOOGLE_DRIVE_WEBHOOK_BASE_URL}/api/integrations/drive/webhook`）
- channel の `expiration` は Google が返す UNIX ms。`DriveWatchChannel.expiresAt` に保存
- `expiresAt - 6h` を切ったら自動 renew（`POST /api/integrations/drive/watch/renew` を手動でも叩ける、本番では cron 想定）
- renew は「新 channel 作成 → 旧 channel `stop` → DB 更新」の順。失敗時は `Integration.status='watch_failed'`

## フロント構成

新規ビュー `data-view="integrations-drive"` を `index.html` / `script.js` に追加。左ナビにも「連携 / Google Drive」を追加。

### 3 ブロック

1. **接続パネル** (`.integration-drive-connection`)
   - 未接続: 「Google Drive と連携」ボタン → `/api/integrations/drive/oauth/authorize` に遷移
   - 接続済: `creds.email`, watch `expiresAt`, `status`バッジ、「切断」ボタン
   - 「ルートフォルダ ID」入力 + 「保存」ボタン（Drive Picker は使わず folderId 直入力で MVP を割り切る）

2. **フォルダ mapping パネル** (`.drive-folder-mappings`)
   - 左: ルート配下のサブフォルダ一覧（`GET /api/integrations/drive/folders` の結果）
   - 各行に zeimee 顧問先選択（`<select>`、`GET /api/clients` から）
   - 「mapping を保存」で `POST /api/integrations/drive/mappings`
   - 既存 mapping は select の初期値として反映、× ボタンで `DELETE`

3. **同期パネル** (`.drive-sync`)
   - 「今すぐ同期」ボタン → `POST /api/integrations/drive/sync`、結果トースト
   - 「最後の同期: 5 分前 / imported 12 件 / failed 1 件」を表示
   - `driveImportStatus='move_failed'` が残ってる Voucher の件数を表示（クリックで詳細遷移は本 spec ではしない、件数表示のみ）

### 既存「証憑登録ビュー」(spec 10) への追加

各サムネ右上に `Voucher.source` バッジ（「手動」 / 「Drive」）を出す。来歴を一目でわかるように。

### appState 追加

```js
driveIntegration: null,         // { connected, email, status, expiresAt }
driveFolders: [],               // ルート直下のサブフォルダ
driveMappings: [],              // DriveFolderMapping[]
driveLastSync: null,            // 直近 sync 結果
```

## エラー処理

| 状況 | 挙動 |
|---|---|
| OAuth トークン期限切れ + refresh 失敗 | sync 中断、`Integration.status='reauth_required'`、フロントでバナー「再連携が必要です」 |
| ファイル DL の 5xx / ネット切断 | そのファイルだけ failed カウンタに加算して skip、`pageToken` は進める。`changes.list` は前回 pageToken からの差分しか返さないので、次回 sync では同じ change は返ってこない。手動で再取り込みしたい場合は Drive 上でそのファイルを更新（任意のメタを変える等）すれば次の change として再ヒットする |
| MIME 不一致 / サイズ超過 | Voucher を作らず skip、Drive 側 move もしない。`pageToken` は進めるので同 change は再来しない |
| Voucher 作成成功 + Drive move 失敗 | Voucher は残し `driveImportStatus='move_failed'`、フロント UI で件数バッジ。Drive 上のファイルは元の場所に残るが、`driveFileId` unique で再取り込みは防がれる（move のリトライは本 spec ではしない） |
| webhook 多重発火 | `driveFileId` unique で冪等 |
| watch channel expire 直前 | `expiresAt - 6h` を切ったら renew |
| watch 登録自体に失敗 | `Integration.status='watch_failed'`、手動 sync は引き続き動く |
| `GOOGLE_DRIVE_WEBHOOK_BASE_URL` 未設定 | `startWatch` は no-op、手動 sync のみで運用 |

## テスト

既存方針（vitest + 実 Postgres、`tests/setup.ts` 経由）を踏襲。Google Drive API は外部のため限定的にスタブする。

### `tests/services/drive-importer.test.ts`（6 ケース）

`drive-service.ts` の `listChanges` / `getFileBinary` / `moveFile` / `ensureImportedSubfolder` を `vi.spyOn` で差し替え。

1. 新規 change → Voucher が作られ `source='drive'` / `driveFileId` がセットされる
2. 既存 `driveFileId` の change → skip（imported カウンタは増えない）
3. 未 mapping サブフォルダ配下の change → skip
4. MIME 非対応の change → skip、Voucher も作らない
5. サイズ 10MB 超の change → skip
6. Voucher 作成成功・move 失敗 → Voucher は残り `driveImportStatus='move_failed'`、failed カウンタ +1

### `tests/routes/integrations-drive.test.ts`（5 ケース）

1. `POST /api/integrations/drive/mappings` で mapping が作成される
2. `DELETE /api/integrations/drive/mappings/:id` で削除される
3. `POST /api/integrations/drive/webhook` で `X-Goog-Channel-ID` 不一致 → 404
4. `POST /api/integrations/drive/webhook` で `X-Goog-Resource-State=sync` → 200 no-op
5. `POST /api/integrations/drive/sync` で `drive-importer` がモックされた状態で結果オブジェクトを返す

### OAuth callback のテスト

Google の token endpoint / userinfo endpoint は `drive-service` のラッパ関数 (`exchangeCode` / `getUserEmail`) を `vi.spyOn` で差し替える。MSW 等の HTTP モックは導入しない（既存テストの最小モック方針を維持）。

フロント側テストは spec 10 同様、基盤無しのため手動確認。

## 受入基準

- [ ] `npm run prisma:migrate` で `Integration` / `DriveFolderMapping` / `DriveWatchChannel` テーブルが作られ、`Voucher` に `source` / `driveFileId` / `driveImportStatus` 列が追加される
- [ ] 環境変数 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` を設定し、`/api/integrations/drive/oauth/authorize` → Google → callback で Integration 行が作られる
- [ ] `/api/integrations/drive/folders` でルート直下のサブフォルダが取れる
- [ ] mapping CRUD が動く
- [ ] mapping 済のサブフォルダに画像を入れ「今すぐ同期」を押すと Voucher が作られる
- [ ] 同じファイルで再 sync しても Voucher は重複しない（unique で弾かれる）
- [ ] 取り込み成功したファイルが Drive 上で「取り込み済」サブフォルダに移動する
- [ ] HEIC / PDF / 11MB 以上 / 未 mapping フォルダのファイルは skip され Voucher が作られない
- [ ] move 失敗をシミュレートすると Voucher は残り `driveImportStatus='move_failed'` になる
- [ ] サーバ側テスト 11 ケース（drive-importer 6 + routes 5）が通る
- [ ] フロント「連携 / Google Drive」ビューで接続・mapping・同期が一通り動く（手動確認）

## スコープ外（後続スペックで扱う）

- **LINE 経由の取り込み**（spec 14）
- **メール添付・転送経由の取り込み**（spec 15）
- 共有ドライブ（Shared Drives）対応 — My Drive のみ
- Drive 上のファイル更新の同期（`changes` で modified が返っても、既存 Voucher の差し替えはしない）
- ゴミ箱からの復活ファイル（`trashed=true` は無視）
- PDF 取り込み（spec 10 と整合、画像のみ）
- ユーザ認証・スタッフごとの権限制御（Drive は事務所共通の 1 アカウントなので本 spec では不要）
- Drive Picker（folderId 直入力で MVP）
- watch renew の cron 自動化（手動 endpoint まで）
- `Integration.creds` の暗号化（プロトタイプ規模、本番化時に検討）

## 後続スペックへの接続点

- LINE / メールも、本 spec で作った `Integration` テーブル（`type='line'` / `'email'`）に creds を保管する形を流用する
- 各チャネルから入ってくるファイルは結局 `voucher-service.createVoucher` を呼んで Voucher を作る → `Voucher.source` を `'line'` / `'email'` に分岐させるだけ
- 「インバウンドソース interface」を共通化するかは本 spec では決めない。spec 14 を実装する時に判断する（Drive と LINE の差が大きいので、無理に統一しないほうがよさそう）
