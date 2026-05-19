# Spec 13 (Google Drive 連携) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zeimee に Google Drive アカウントを 1 つ繋ぎ、サブフォルダを顧問先と手動 mapping し、画像レシートを自動取り込みする経路を実装する。Push Notification（本番）と手動「今すぐ同期」ボタン（開発）の両方をサポート。取り込んだ Voucher は spec 11/12 のパイプラインにそのまま乗る。

**Architecture:** `Integration`（汎用形、種別 string + creds Json）/ `DriveFolderMapping` / `DriveWatchChannel` の 3 テーブル + `Voucher` への 3 列追加。サーバは `integration-service.ts` / `drive-service.ts`（googleapis ラッパ）/ `drive-importer.ts`（同期処理本体）/ `routes/integrations-drive.ts` に分離。フロントは `data-view="integrations-drive"` を新規追加し既存 Vanilla JS パターンに乗せる。

**Tech Stack:** Fastify 5 / Prisma 6 / Postgres 16 / Vitest 3 / `googleapis` npm パッケージ / Vanilla JS フロント

**Spec:** `docs/superpowers/specs/2026-05-19-13-voucher-inbound-drive-design.md`

**ファイル構成（プラン全体での全タッチ）**

- 新規 `server/src/services/integration-service.ts` — Integration 行の CRUD と `ensureDriveToken`
- 新規 `server/src/services/drive-service.ts` — googleapis ラッパ（OAuth / files / changes / watch）
- 新規 `server/src/services/drive-importer.ts` — `syncDriveChanges` 本体
- 新規 `server/src/routes/integrations-drive.ts` — 10 endpoints
- 新規 `server/tests/services/integration-service.test.ts`
- 新規 `server/tests/services/drive-importer.test.ts`
- 新規 `server/tests/routes/integrations-drive.test.ts`
- 修正 `server/prisma/schema.prisma` — 3 モデル追加 + Voucher 拡張
- 修正 `server/src/env.ts` — Google 系 env vars 追加
- 修正 `server/src/server.ts` — `integrationsDriveRoutes` を `register`
- 修正 `server/.env.example` — Google 系の例を追記
- 修正 `server/package.json` — `googleapis` 追加
- 修正 `script.js` — 新ビュー / appState 拡張 / レンダ関数
- 修正 `index.html` — 左ナビ項目 + ビュー container 追加
- 修正 `styles.css` — 新ビューのスタイル

---

## Task 1: Prisma スキーマと Voucher 拡張

**Files:**
- Modify: `server/prisma/schema.prisma:53` (Client に `driveFolderMappings` リレーション追加), `server/prisma/schema.prisma:230-259` (Voucher 拡張), 末尾に 3 モデル追加

- [ ] **Step 1: Voucher に新規 3 列を追加**

`server/prisma/schema.prisma` の `model Voucher` ブロック末尾、`inquiries VoucherInquiry[]` の直前に追加：

```prisma
  // Spec 13: Drive 連携用
  source            String   @default("manual")
  driveFileId       String?  @unique
  driveImportStatus String?
```

- [ ] **Step 2: Client に `driveFolderMappings` リレーションを追加**

`server/prisma/schema.prisma:53` の `vouchers Voucher[]` の直後に：

```prisma
  driveFolderMappings DriveFolderMapping[]
```

- [ ] **Step 3: ファイル末尾に 3 モデルを追加**

`server/prisma/schema.prisma` の末尾に：

```prisma
model Integration {
  id        String   @id @default(cuid())
  type      String
  creds     Json
  settings  Json     @default("{}")
  enabled   Boolean  @default(true)
  status    String   @default("ok")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([type])
}

model DriveFolderMapping {
  id                  String   @id @default(cuid())
  driveFolderId       String   @unique
  folderName          String
  importedSubfolderId String?
  client              Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId            String
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([clientId])
}

model DriveWatchChannel {
  id         String   @id @default(cuid())
  channelId  String   @unique
  resourceId String
  pageToken  String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
}
```

- [ ] **Step 4: マイグレーション**

Run:
```bash
cd server && npx prisma migrate dev --name spec13_drive_inbound
```
Expected: `Applied migration ... spec13_drive_inbound`、Prisma Client 再生成完了。

- [ ] **Step 5: 確認**

Run:
```bash
cd server && npx prisma studio
```
（手動）Integration / DriveFolderMapping / DriveWatchChannel / Voucher（拡張済）が見えること。タブを閉じる。

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat(spec 13): add Integration, DriveFolderMapping, DriveWatchChannel + Voucher source/driveFileId

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: 環境変数追加と googleapis インストール

**Files:**
- Modify: `server/src/env.ts:32`
- Modify: `server/.env.example`
- Modify: `server/package.json` (依存追加)

- [ ] **Step 1: env.ts に Google 系を追加**

`server/src/env.ts:38` の `OUTREACH_LINE_TOKEN` の次行に：

```ts
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),
  GOOGLE_DRIVE_WEBHOOK_BASE_URL: z.string().default(''),
```

- [ ] **Step 2: .env.example に追記**

`server/.env.example` を Read してから、末尾に：

```
# Google Drive 連携 (spec 13)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/integrations/drive/oauth/callback
GOOGLE_DRIVE_WEBHOOK_BASE_URL=
```

- [ ] **Step 3: googleapis をインストール**

Run:
```bash
cd server && npm install googleapis@^144
```
Expected: `added N packages`、`server/package.json` の `dependencies` に `googleapis` が入る、`server/package-lock.json` 更新。

- [ ] **Step 4: tsc が通ることを確認**

Run:
```bash
cd server && npm run build
```
Expected: `tsc -p tsconfig.json` がエラー無く完了。

- [ ] **Step 5: Commit**

```bash
git add server/src/env.ts server/.env.example server/package.json server/package-lock.json
git commit -m "feat(spec 13): add Google env vars and googleapis dep

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: integration-service の CRUD（テスト先行）

**Files:**
- Create: `server/src/services/integration-service.ts`
- Create: `server/tests/services/integration-service.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/services/integration-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import {
  upsertIntegration,
  getIntegration,
  deleteIntegration,
  updateIntegrationStatus,
} from '../../src/services/integration-service.js';

beforeEach(async () => {
  await prisma.integration.deleteMany();
});

afterAll(async () => {
  await prisma.integration.deleteMany();
  await prisma.$disconnect();
});

describe('upsertIntegration', () => {
  it('creates a new row when none exists for the type', async () => {
    const row = await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A', refreshToken: 'R', expiresAt: 0 },
      settings: { rootFolderId: 'F1' },
    });
    expect(row.id).toBeTruthy();
    expect(row.type).toBe('google_drive');
    expect((row.creds as { accessToken: string }).accessToken).toBe('A');
  });

  it('updates an existing row of the same type', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: {},
    });
    const updated = await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'B' },
      settings: { rootFolderId: 'F2' },
    });
    expect((updated.creds as { accessToken: string }).accessToken).toBe('B');
    expect((updated.settings as { rootFolderId: string }).rootFolderId).toBe('F2');
    const count = await prisma.integration.count({ where: { type: 'google_drive' } });
    expect(count).toBe(1);
  });
});

describe('getIntegration', () => {
  it('returns null when not configured', async () => {
    expect(await getIntegration('google_drive')).toBeNull();
  });

  it('returns the row when configured', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: {},
    });
    const row = await getIntegration('google_drive');
    expect(row).not.toBeNull();
    expect(row!.type).toBe('google_drive');
  });
});

describe('deleteIntegration', () => {
  it('removes the row and returns true', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: {},
    });
    expect(await deleteIntegration('google_drive')).toBe(true);
    expect(await getIntegration('google_drive')).toBeNull();
  });

  it('returns false when nothing to delete', async () => {
    expect(await deleteIntegration('google_drive')).toBe(false);
  });
});

describe('updateIntegrationStatus', () => {
  it('updates the status field', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: {},
    });
    await updateIntegrationStatus('google_drive', 'reauth_required');
    const row = await getIntegration('google_drive');
    expect(row?.status).toBe('reauth_required');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run:
```bash
cd server && npx vitest run tests/services/integration-service.test.ts
```
Expected: FAIL — `Cannot find module '../../src/services/integration-service.js'`。

- [ ] **Step 3: 実装**

`server/src/services/integration-service.ts`:

```ts
import { prisma } from '../lib/prisma.js';
import type { Integration } from '@prisma/client';

export async function upsertIntegration(input: {
  type: string;
  creds: object;
  settings: object;
}): Promise<Integration> {
  return prisma.integration.upsert({
    where: { type: input.type },
    create: {
      type: input.type,
      creds: input.creds as object,
      settings: input.settings as object,
    },
    update: {
      creds: input.creds as object,
      settings: input.settings as object,
    },
  });
}

export async function getIntegration(type: string): Promise<Integration | null> {
  return prisma.integration.findUnique({ where: { type } });
}

export async function deleteIntegration(type: string): Promise<boolean> {
  const result = await prisma.integration.deleteMany({ where: { type } });
  return result.count > 0;
}

export async function updateIntegrationStatus(
  type: string,
  status: string,
): Promise<void> {
  await prisma.integration.updateMany({ where: { type }, data: { status } });
}
```

- [ ] **Step 4: テストパス**

Run:
```bash
cd server && npx vitest run tests/services/integration-service.test.ts
```
Expected: PASS（6 ケース）

- [ ] **Step 5: Commit**

```bash
git add server/src/services/integration-service.ts server/tests/services/integration-service.test.ts
git commit -m "feat(spec 13): integration-service CRUD with 6 TDD cases

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: ensureDriveToken（トークン refresh ロジック）

**Files:**
- Modify: `server/src/services/integration-service.ts`
- Modify: `server/tests/services/integration-service.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/integration-service.test.ts` の末尾に追加：

```ts
import * as driveService from '../../src/services/drive-service.js';
import { vi } from 'vitest';
import { ensureDriveToken } from '../../src/services/integration-service.js';

describe('ensureDriveToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the existing token when not expiring soon', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: {
        accessToken: 'fresh-token',
        refreshToken: 'r',
        expiresAt: Date.now() + 600_000, // 10 min left
      },
      settings: {},
    });
    const token = await ensureDriveToken();
    expect(token).toBe('fresh-token');
  });

  it('refreshes when expiring within 60 seconds', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: {
        accessToken: 'old-token',
        refreshToken: 'r',
        expiresAt: Date.now() + 30_000, // 30s left
      },
      settings: {},
    });
    vi.spyOn(driveService, 'refreshAccessToken').mockResolvedValue({
      accessToken: 'new-token',
      expiresIn: 3600,
    });
    const token = await ensureDriveToken();
    expect(token).toBe('new-token');
    const row = await getIntegration('google_drive');
    const creds = row!.creds as { accessToken: string };
    expect(creds.accessToken).toBe('new-token');
  });

  it('returns null and marks status=reauth_required on refresh failure', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: {
        accessToken: 'old-token',
        refreshToken: 'r',
        expiresAt: Date.now() + 30_000,
      },
      settings: {},
    });
    vi.spyOn(driveService, 'refreshAccessToken').mockRejectedValue(
      new Error('invalid_grant'),
    );
    const token = await ensureDriveToken();
    expect(token).toBeNull();
    const row = await getIntegration('google_drive');
    expect(row?.status).toBe('reauth_required');
  });

  it('returns null when no integration configured', async () => {
    const token = await ensureDriveToken();
    expect(token).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run:
```bash
cd server && npx vitest run tests/services/integration-service.test.ts -t ensureDriveToken
```
Expected: FAIL — `drive-service` import が解決できない、`ensureDriveToken` 未定義。

- [ ] **Step 3: 一旦 drive-service の最小スタブを作る**

`server/src/services/drive-service.ts`（最小スタブのみ。本実装は Task 5-8）:

```ts
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
}> {
  throw new Error('not implemented yet');
}
```

- [ ] **Step 4: ensureDriveToken を実装**

`server/src/services/integration-service.ts` に追記：

```ts
import { refreshAccessToken as driveRefreshAccessToken } from './drive-service.js';

interface DriveCreds {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  email?: string;
}

export async function ensureDriveToken(): Promise<string | null> {
  const row = await getIntegration('google_drive');
  if (!row) return null;
  const creds = row.creds as DriveCreds;
  if (!creds.accessToken) return null;
  const now = Date.now();
  const expiringSoon =
    !creds.expiresAt || creds.expiresAt - now < 60_000;
  if (!expiringSoon) return creds.accessToken;
  if (!creds.refreshToken) return creds.accessToken;
  try {
    const refreshed = await driveRefreshAccessToken(creds.refreshToken);
    const newCreds: DriveCreds = {
      ...creds,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? creds.refreshToken,
      expiresAt: refreshed.expiresIn
        ? Date.now() + refreshed.expiresIn * 1000
        : undefined,
    };
    await prisma.integration.update({
      where: { type: 'google_drive' },
      data: { creds: newCreds as object },
    });
    return refreshed.accessToken;
  } catch {
    await updateIntegrationStatus('google_drive', 'reauth_required');
    return null;
  }
}
```

- [ ] **Step 5: テストパス**

Run:
```bash
cd server && npx vitest run tests/services/integration-service.test.ts
```
Expected: 全 10 ケース PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/services/integration-service.ts server/src/services/drive-service.ts server/tests/services/integration-service.test.ts
git commit -m "feat(spec 13): ensureDriveToken with refresh + reauth_required handling

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: drive-service の OAuth ラッパ（実装のみ、ユニットテスト無し）

**Files:**
- Modify: `server/src/services/drive-service.ts`

**Note:** drive-service は googleapis への薄いラッパなので、直接のユニットテストは行わない（既存 mf-api.ts と同じ方針）。テストは drive-importer / routes 側で `vi.spyOn` する。

- [ ] **Step 1: drive-service.ts を全面実装（OAuth 部分）**

`server/src/services/drive-service.ts` を以下で**全置換**：

```ts
import { google, type drive_v3 } from 'googleapis';
import { env } from '../env.js';

// ---------- OAuth helpers ----------

export function buildAuthorizeUrl(): string {
  const oauth2 = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

export async function exchangeCode(code: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}> {
  const oauth2 = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
  const { tokens } = await oauth2.getToken(code);
  return {
    accessToken: tokens.access_token ?? '',
    refreshToken: tokens.refresh_token ?? undefined,
    expiresIn: tokens.expiry_date
      ? Math.max(0, Math.floor((tokens.expiry_date - Date.now()) / 1000))
      : undefined,
    scope: tokens.scope ?? undefined,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
}> {
  const oauth2 = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();
  return {
    accessToken: credentials.access_token ?? '',
    expiresIn: credentials.expiry_date
      ? Math.max(0, Math.floor((credentials.expiry_date - Date.now()) / 1000))
      : undefined,
    refreshToken: credentials.refresh_token ?? undefined,
  };
}

export async function getUserEmail(accessToken: string): Promise<string | null> {
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
  const res = await oauth2Api.userinfo.get();
  return res.data.email ?? null;
}

// ---------- Drive helpers (folders / changes / files / watch) ----------

function driveClient(accessToken: string): drive_v3.Drive {
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2 });
}

export interface DriveSubfolder {
  id: string;
  name: string;
}

export async function listSubfolders(
  accessToken: string,
  parentId: string,
): Promise<DriveSubfolder[]> {
  const d = driveClient(accessToken);
  const res = await d.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 100,
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? '',
    name: f.name ?? '',
  }));
}

export async function getStartPageToken(accessToken: string): Promise<string> {
  const d = driveClient(accessToken);
  const res = await d.changes.getStartPageToken();
  return res.data.startPageToken ?? '';
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    size: number;
    trashed: boolean;
  };
}

export interface DriveChangesPage {
  changes: DriveChange[];
  nextPageToken?: string;
}

export async function listChanges(
  accessToken: string,
  pageToken: string,
): Promise<DriveChangesPage> {
  const d = driveClient(accessToken);
  const res = await d.changes.list({
    pageToken,
    includeRemoved: false,
    fields:
      'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,size,trashed))',
    pageSize: 100,
  });
  const changes: DriveChange[] = (res.data.changes ?? []).map((c) => ({
    fileId: c.fileId ?? '',
    removed: c.removed ?? false,
    file: c.file
      ? {
          id: c.file.id ?? '',
          name: c.file.name ?? '',
          mimeType: c.file.mimeType ?? '',
          parents: c.file.parents ?? [],
          size: Number(c.file.size ?? 0),
          trashed: c.file.trashed ?? false,
        }
      : undefined,
  }));
  return {
    changes,
    nextPageToken: res.data.nextPageToken ?? res.data.newStartPageToken ?? undefined,
  };
}

export async function getFileBinary(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const d = driveClient(accessToken);
  const res = await d.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

export async function ensureImportedSubfolder(
  accessToken: string,
  parentId: string,
  subfolderName: string,
): Promise<string> {
  const d = driveClient(accessToken);
  // 既存検索
  const found = await d.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${subfolderName.replace(/'/g, "\\'")}' and trashed=false`,
    fields: 'files(id)',
    pageSize: 1,
  });
  const existing = found.data.files?.[0]?.id;
  if (existing) return existing;
  // 無ければ作る
  const created = await d.files.create({
    requestBody: {
      name: subfolderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return created.data.id ?? '';
}

export async function moveFile(
  accessToken: string,
  fileId: string,
  fromParentId: string,
  toParentId: string,
): Promise<void> {
  const d = driveClient(accessToken);
  await d.files.update({
    fileId,
    addParents: toParentId,
    removeParents: fromParentId,
    fields: 'id,parents',
  });
}

export interface DriveWatchResult {
  channelId: string;
  resourceId: string;
  expiresAt: Date;
}

export async function startWatch(opts: {
  accessToken: string;
  pageToken: string;
  webhookUrl: string;
}): Promise<DriveWatchResult> {
  const d = driveClient(opts.accessToken);
  const channelId = `zeimee-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await d.changes.watch({
    pageToken: opts.pageToken,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: opts.webhookUrl,
    },
  });
  return {
    channelId,
    resourceId: res.data.resourceId ?? '',
    expiresAt: new Date(Number(res.data.expiration ?? Date.now() + 24 * 60 * 60 * 1000)),
  };
}

export async function stopWatch(opts: {
  accessToken: string;
  channelId: string;
  resourceId: string;
}): Promise<void> {
  const d = driveClient(opts.accessToken);
  await d.channels.stop({
    requestBody: { id: opts.channelId, resourceId: opts.resourceId },
  });
}
```

- [ ] **Step 2: 既存テストが壊れていないことを確認**

Run:
```bash
cd server && npx vitest run tests/services/integration-service.test.ts
```
Expected: 全 10 ケース PASS（drive-service の `refreshAccessToken` シグネチャが同じなので spy が引き続き効く）。

- [ ] **Step 3: tsc を通す**

Run:
```bash
cd server && npm run build
```
Expected: エラー無く完了。

- [ ] **Step 4: Commit**

```bash
git add server/src/services/drive-service.ts
git commit -m "feat(spec 13): drive-service wrapper for OAuth + files + changes + watch

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: drive-importer のブートストラップ（初回 sync で pageToken のみ保存）

**Files:**
- Create: `server/src/services/drive-importer.ts`
- Create: `server/tests/services/drive-importer.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/services/drive-importer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import * as driveService from '../../src/services/drive-service.js';
import { upsertIntegration } from '../../src/services/integration-service.js';
import { syncDriveChanges } from '../../src/services/drive-importer.js';

beforeEach(async () => {
  await prisma.driveWatchChannel.deleteMany();
  await prisma.driveFolderMapping.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.integration.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.driveWatchChannel.deleteMany();
  await prisma.driveFolderMapping.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.$disconnect();
});

async function seedIntegration() {
  await upsertIntegration({
    type: 'google_drive',
    creds: {
      accessToken: 'A',
      refreshToken: 'R',
      expiresAt: Date.now() + 600_000,
    },
    settings: { rootFolderId: 'ROOT', importedSubfolderName: '取り込み済' },
  });
}

describe('syncDriveChanges - bootstrap', () => {
  it('returns scanned=0 when no Integration exists', async () => {
    const result = await syncDriveChanges({ trigger: 'manual' });
    expect(result).toMatchObject({ scanned: 0, imported: 0, skipped: 0, failed: 0 });
  });

  it('first run with no DriveWatchChannel: saves startPageToken and exits', async () => {
    await seedIntegration();
    vi.spyOn(driveService, 'getStartPageToken').mockResolvedValue('PT0');
    const listSpy = vi.spyOn(driveService, 'listChanges');
    const result = await syncDriveChanges({ trigger: 'manual' });
    expect(result).toMatchObject({ scanned: 0, imported: 0, skipped: 0, failed: 0, lastPageToken: 'PT0' });
    expect(listSpy).not.toHaveBeenCalled();
    const ch = await prisma.driveWatchChannel.findMany();
    expect(ch).toHaveLength(1);
    expect(ch[0].pageToken).toBe('PT0');
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run:
```bash
cd server && npx vitest run tests/services/drive-importer.test.ts
```
Expected: FAIL — `Cannot find module '.../drive-importer.js'`

- [ ] **Step 3: 最小実装（ブートストラップだけ）**

`server/src/services/drive-importer.ts`:

```ts
import { prisma } from '../lib/prisma.js';
import { ensureDriveToken, getIntegration } from './integration-service.js';
import * as drive from './drive-service.js';

export interface SyncResult {
  trigger: 'manual' | 'webhook';
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  lastPageToken: string;
}

export async function syncDriveChanges(opts?: {
  trigger?: 'manual' | 'webhook';
}): Promise<SyncResult> {
  const trigger = opts?.trigger ?? 'manual';
  const empty: SyncResult = {
    trigger,
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    lastPageToken: '',
  };
  const integ = await getIntegration('google_drive');
  if (!integ) return empty;
  const token = await ensureDriveToken();
  if (!token) return empty;
  const channel = await prisma.driveWatchChannel.findFirst();
  if (!channel) {
    const startToken = await drive.getStartPageToken(token);
    await prisma.driveWatchChannel.create({
      data: {
        channelId: `bootstrap-${Date.now()}`,
        resourceId: '',
        pageToken: startToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    return { ...empty, lastPageToken: startToken };
  }
  // 次タスクでループ本体を追加。今はブートストラップだけ実装し、
  // 既存 channel がある場合は現 pageToken を返して終了する。
  return { ...empty, lastPageToken: channel.pageToken };
}
```

- [ ] **Step 4: テストパス**

Run:
```bash
cd server && npx vitest run tests/services/drive-importer.test.ts
```
Expected: 2 ケース PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/drive-importer.ts server/tests/services/drive-importer.test.ts
git commit -m "feat(spec 13): drive-importer bootstrap saves startPageToken on first run

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: drive-importer の正常系（新規ファイルを取り込み、Drive 上で move）

**Files:**
- Modify: `server/src/services/drive-importer.ts`
- Modify: `server/tests/services/drive-importer.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/drive-importer.test.ts` の末尾に追加：

```ts
async function seedMapping(opts: {
  driveFolderId: string;
  clientId: string;
  importedSubfolderId?: string;
}) {
  await prisma.driveFolderMapping.create({
    data: {
      driveFolderId: opts.driveFolderId,
      folderName: `name-${opts.driveFolderId}`,
      clientId: opts.clientId,
      importedSubfolderId: opts.importedSubfolderId ?? null,
    },
  });
}

async function seedWatchChannel(pageToken: string) {
  await prisma.driveWatchChannel.create({
    data: {
      channelId: `ch-${Date.now()}`,
      resourceId: 'r',
      pageToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
}

describe('syncDriveChanges - happy path', () => {
  it('imports a new image in a mapped folder, creates Voucher, and moves file', async () => {
    await seedIntegration();
    await seedWatchChannel('PT0');
    await seedMapping({ driveFolderId: 'F1', clientId: 'aoyama-design' });

    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'file-001',
          removed: false,
          file: {
            id: 'file-001',
            name: 'receipt.jpg',
            mimeType: 'image/jpeg',
            parents: ['F1'],
            size: 1024,
            trashed: false,
          },
        },
      ],
      nextPageToken: 'PT1',
    });
    vi.spyOn(driveService, 'getFileBinary').mockResolvedValue(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    );
    vi.spyOn(driveService, 'ensureImportedSubfolder').mockResolvedValue('IMP1');
    const moveSpy = vi.spyOn(driveService, 'moveFile').mockResolvedValue();

    const result = await syncDriveChanges({ trigger: 'manual' });

    expect(result).toMatchObject({
      scanned: 1,
      imported: 1,
      skipped: 0,
      failed: 0,
      lastPageToken: 'PT1',
    });
    const vouchers = await prisma.voucher.findMany({
      where: { driveFileId: 'file-001' },
    });
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].source).toBe('drive');
    expect(vouchers[0].clientId).toBe('aoyama-design');
    expect(vouchers[0].filename).toBe('receipt.jpg');
    expect(vouchers[0].driveImportStatus).toBe('imported');
    expect(moveSpy).toHaveBeenCalledWith('A', 'file-001', 'F1', 'IMP1');

    const channels = await prisma.driveWatchChannel.findMany();
    expect(channels[0].pageToken).toBe('PT1');
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run:
```bash
cd server && npx vitest run tests/services/drive-importer.test.ts
```
Expected: FAIL — happy path テストが failed=0 / imported=1 期待だが、現状の実装は素通しで scanned=0 を返す。

- [ ] **Step 3: 実装拡張（ループ本体を追加）**

`server/src/services/drive-importer.ts` を以下で**全置換**：

```ts
import { prisma } from '../lib/prisma.js';
import { ensureDriveToken, getIntegration } from './integration-service.js';
import * as drive from './drive-service.js';
import { createVoucher } from './voucher-service.js';

export interface SyncResult {
  trigger: 'manual' | 'webhook';
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  lastPageToken: string;
}

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const MAX_SIZE = 10 * 1024 * 1024;

export async function syncDriveChanges(opts?: {
  trigger?: 'manual' | 'webhook';
}): Promise<SyncResult> {
  const trigger = opts?.trigger ?? 'manual';
  const empty: SyncResult = {
    trigger,
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    lastPageToken: '',
  };

  const integ = await getIntegration('google_drive');
  if (!integ) return empty;
  const token = await ensureDriveToken();
  if (!token) return empty;
  const settings = integ.settings as { importedSubfolderName?: string };
  const subfolderName = settings.importedSubfolderName ?? '取り込み済';

  const channel = await prisma.driveWatchChannel.findFirst();
  if (!channel) {
    const startToken = await drive.getStartPageToken(token);
    await prisma.driveWatchChannel.create({
      data: {
        channelId: `bootstrap-${Date.now()}`,
        resourceId: '',
        pageToken: startToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    return { ...empty, lastPageToken: startToken };
  }

  let scanned = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let lastSavedPageToken = channel.pageToken;
  let pageToken: string | undefined = channel.pageToken;

  const mappings = await prisma.driveFolderMapping.findMany();
  const mappingByFolder = new Map(mappings.map((m) => [m.driveFolderId, m]));

  while (pageToken) {
    const page = await drive.listChanges(token, pageToken);
    for (const change of page.changes) {
      scanned += 1;
      const file = change.file;
      if (!file || file.trashed) {
        skipped += 1;
        continue;
      }
      const parentMapping = file.parents
        .map((p) => mappingByFolder.get(p))
        .find((m) => m);
      if (!parentMapping) {
        skipped += 1;
        continue;
      }
      const existing = await prisma.voucher.findUnique({
        where: { driveFileId: file.id },
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      if (!ALLOWED_MIMES.has(file.mimeType)) {
        skipped += 1;
        continue;
      }
      if (file.size > MAX_SIZE) {
        skipped += 1;
        continue;
      }
      try {
        const buffer = await drive.getFileBinary(token, file.id);
        const meta = await createVoucher({
          clientId: parentMapping.clientId,
          filename: file.name,
          mimeType: file.mimeType,
          buffer,
          uploadedBy: 'drive',
        });
        await prisma.voucher.update({
          where: { id: meta.id },
          data: {
            source: 'drive',
            driveFileId: file.id,
            driveImportStatus: 'imported',
          },
        });
        let subfolderId = parentMapping.importedSubfolderId;
        if (!subfolderId) {
          subfolderId = await drive.ensureImportedSubfolder(
            token,
            parentMapping.driveFolderId,
            subfolderName,
          );
          await prisma.driveFolderMapping.update({
            where: { id: parentMapping.id },
            data: { importedSubfolderId: subfolderId },
          });
        }
        try {
          await drive.moveFile(
            token,
            file.id,
            parentMapping.driveFolderId,
            subfolderId,
          );
          imported += 1;
        } catch {
          await prisma.voucher.update({
            where: { id: meta.id },
            data: { driveImportStatus: 'move_failed' },
          });
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    if (page.nextPageToken) {
      lastSavedPageToken = page.nextPageToken;
    }
    pageToken = page.nextPageToken;
  }

  await prisma.driveWatchChannel.update({
    where: { id: channel.id },
    data: { pageToken: lastSavedPageToken },
  });

  return {
    trigger,
    scanned,
    imported,
    skipped,
    failed,
    lastPageToken: lastSavedPageToken,
  };
}
```

- [ ] **Step 4: テスト全件パス**

Run:
```bash
cd server && npx vitest run tests/services/drive-importer.test.ts
```
Expected: 3 ケース PASS（bootstrap 2 + happy path 1）

- [ ] **Step 5: Commit**

```bash
git add server/src/services/drive-importer.ts server/tests/services/drive-importer.test.ts
git commit -m "feat(spec 13): drive-importer happy path imports + moves new files

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: drive-importer の skip ケース（既存 driveFileId / 未 mapping / MIME / サイズ）

**Files:**
- Modify: `server/tests/services/drive-importer.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/drive-importer.test.ts` の末尾に追加：

```ts
describe('syncDriveChanges - skip cases', () => {
  it('skips a change whose file is in an unmapped folder', async () => {
    await seedIntegration();
    await seedWatchChannel('PT0');
    // No mapping created
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'f',
          removed: false,
          file: {
            id: 'f',
            name: 'a.jpg',
            mimeType: 'image/jpeg',
            parents: ['UNMAPPED'],
            size: 100,
            trashed: false,
          },
        },
      ],
      nextPageToken: 'PT1',
    });
    const r = await syncDriveChanges({ trigger: 'manual' });
    expect(r.scanned).toBe(1);
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
    expect(await prisma.voucher.count()).toBe(0);
  });

  it('skips when a Voucher with the same driveFileId already exists', async () => {
    await seedIntegration();
    await seedWatchChannel('PT0');
    await seedMapping({ driveFolderId: 'F1', clientId: 'aoyama-design' });
    // Existing voucher with same driveFileId
    await prisma.voucher.create({
      data: {
        clientId: 'aoyama-design',
        filename: 'old.jpg',
        mimeType: 'image/jpeg',
        size: 1,
        imageData: Buffer.from([0xff]),
        source: 'drive',
        driveFileId: 'dup-1',
        driveImportStatus: 'imported',
      },
    });
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'dup-1',
          removed: false,
          file: {
            id: 'dup-1',
            name: 'old.jpg',
            mimeType: 'image/jpeg',
            parents: ['F1'],
            size: 100,
            trashed: false,
          },
        },
      ],
      nextPageToken: 'PT1',
    });
    const r = await syncDriveChanges({ trigger: 'manual' });
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
    expect(await prisma.voucher.count()).toBe(1);
  });

  it('skips non-image MIME types', async () => {
    await seedIntegration();
    await seedWatchChannel('PT0');
    await seedMapping({ driveFolderId: 'F1', clientId: 'aoyama-design' });
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'pdf-1',
          removed: false,
          file: {
            id: 'pdf-1',
            name: 'a.pdf',
            mimeType: 'application/pdf',
            parents: ['F1'],
            size: 100,
            trashed: false,
          },
        },
      ],
      nextPageToken: 'PT1',
    });
    const r = await syncDriveChanges({ trigger: 'manual' });
    expect(r.skipped).toBe(1);
    expect(r.imported).toBe(0);
    expect(await prisma.voucher.count()).toBe(0);
  });

  it('skips files larger than 10MB', async () => {
    await seedIntegration();
    await seedWatchChannel('PT0');
    await seedMapping({ driveFolderId: 'F1', clientId: 'aoyama-design' });
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'big-1',
          removed: false,
          file: {
            id: 'big-1',
            name: 'big.jpg',
            mimeType: 'image/jpeg',
            parents: ['F1'],
            size: 11 * 1024 * 1024,
            trashed: false,
          },
        },
      ],
      nextPageToken: 'PT1',
    });
    const r = await syncDriveChanges({ trigger: 'manual' });
    expect(r.skipped).toBe(1);
    expect(r.imported).toBe(0);
  });
});
```

- [ ] **Step 2: テストパス**

Run:
```bash
cd server && npx vitest run tests/services/drive-importer.test.ts
```
Expected: 全 7 ケース PASS。実装はすでに skip ロジックを書いてあるので追加実装は無し。

- [ ] **Step 3: Commit**

```bash
git add server/tests/services/drive-importer.test.ts
git commit -m "test(spec 13): drive-importer skip cases (unmapped, dup, mime, size)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: drive-importer の move 失敗ケース

**Files:**
- Modify: `server/tests/services/drive-importer.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/services/drive-importer.test.ts` の末尾に追加：

```ts
describe('syncDriveChanges - move failure', () => {
  it('keeps Voucher but marks driveImportStatus=move_failed when move fails', async () => {
    await seedIntegration();
    await seedWatchChannel('PT0');
    await seedMapping({
      driveFolderId: 'F1',
      clientId: 'aoyama-design',
      importedSubfolderId: 'IMP1',
    });
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'fail-1',
          removed: false,
          file: {
            id: 'fail-1',
            name: 'm.jpg',
            mimeType: 'image/jpeg',
            parents: ['F1'],
            size: 100,
            trashed: false,
          },
        },
      ],
      nextPageToken: 'PT1',
    });
    vi.spyOn(driveService, 'getFileBinary').mockResolvedValue(
      Buffer.from([0xff]),
    );
    vi.spyOn(driveService, 'moveFile').mockRejectedValue(
      new Error('drive 5xx'),
    );

    const r = await syncDriveChanges({ trigger: 'manual' });
    expect(r.imported).toBe(0);
    expect(r.failed).toBe(1);
    const v = await prisma.voucher.findUnique({
      where: { driveFileId: 'fail-1' },
    });
    expect(v).not.toBeNull();
    expect(v?.driveImportStatus).toBe('move_failed');
  });
});
```

- [ ] **Step 2: テストパス**

Run:
```bash
cd server && npx vitest run tests/services/drive-importer.test.ts
```
Expected: 全 8 ケース PASS。実装側はすでに move 失敗時の挙動を書いてあるので追加実装無し。

- [ ] **Step 3: Commit**

```bash
git add server/tests/services/drive-importer.test.ts
git commit -m "test(spec 13): drive-importer marks driveImportStatus=move_failed

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: routes/integrations-drive.ts のスケルトンと status / disconnect

**Files:**
- Create: `server/src/routes/integrations-drive.ts`
- Modify: `server/src/server.ts`
- Create: `server/tests/routes/integrations-drive.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/routes/integrations-drive.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import * as driveService from '../../src/services/drive-service.js';
import { upsertIntegration } from '../../src/services/integration-service.js';

const app = await buildApp();

beforeEach(async () => {
  await prisma.driveWatchChannel.deleteMany();
  await prisma.driveFolderMapping.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.integration.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.driveWatchChannel.deleteMany();
  await prisma.driveFolderMapping.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.integration.deleteMany();
  await app.close();
});

describe('GET /api/integrations/drive', () => {
  it('returns connected=false when not configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false });
  });

  it('returns connected=true with email when configured', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A', email: 'staff@example.com' },
      settings: { rootFolderId: 'ROOT' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      connected: true,
      email: 'staff@example.com',
      rootFolderId: 'ROOT',
    });
  });
});

describe('DELETE /api/integrations/drive', () => {
  it('removes the integration row', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: {},
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/integrations/drive',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await prisma.integration.count()).toBe(0);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts
```
Expected: FAIL — route 未登録。

- [ ] **Step 3: route スケルトン実装**

`server/src/routes/integrations-drive.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  getIntegration,
  deleteIntegration,
} from '../services/integration-service.js';
import { prisma } from '../lib/prisma.js';

export async function integrationsDriveRoutes(app: FastifyInstance) {
  app.get('/api/integrations/drive', async () => {
    const row = await getIntegration('google_drive');
    if (!row) return { connected: false };
    const creds = row.creds as { email?: string };
    const settings = row.settings as { rootFolderId?: string };
    const channel = await prisma.driveWatchChannel.findFirst();
    return {
      connected: true,
      email: creds.email ?? null,
      rootFolderId: settings.rootFolderId ?? null,
      status: row.status,
      watchExpiresAt: channel?.expiresAt ?? null,
    };
  });

  app.delete('/api/integrations/drive', async () => {
    await prisma.driveWatchChannel.deleteMany();
    await prisma.driveFolderMapping.deleteMany();
    await deleteIntegration('google_drive');
    return { ok: true };
  });
}
```

- [ ] **Step 4: server.ts に register 追加**

`server/src/server.ts:21` の `import { voucherRoutes }` の直後に：

```ts
import { integrationsDriveRoutes } from './routes/integrations-drive.js';
```

`server/src/server.ts:54` の `await app.register(voucherRoutes);` の直後に：

```ts
  await app.register(integrationsDriveRoutes);
```

- [ ] **Step 5: テストパス**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts
```
Expected: 3 ケース PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/integrations-drive.ts server/src/server.ts server/tests/routes/integrations-drive.test.ts
git commit -m "feat(spec 13): GET/DELETE /api/integrations/drive

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: OAuth authorize → callback

**Files:**
- Modify: `server/src/routes/integrations-drive.ts`
- Modify: `server/tests/routes/integrations-drive.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/routes/integrations-drive.test.ts` の末尾に追加：

```ts
describe('GET /api/integrations/drive/oauth/authorize', () => {
  it('redirects to the authorize URL from drive-service', async () => {
    vi.spyOn(driveService, 'buildAuthorizeUrl').mockReturnValue(
      'https://accounts.google.com/o/oauth2/v2/auth?fake',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive/oauth/authorize',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com');
  });
});

describe('GET /api/integrations/drive/oauth/callback', () => {
  it('exchanges code, persists integration row, returns HTML', async () => {
    vi.spyOn(driveService, 'exchangeCode').mockResolvedValue({
      accessToken: 'new-AT',
      refreshToken: 'new-RT',
      expiresIn: 3600,
    });
    vi.spyOn(driveService, 'getUserEmail').mockResolvedValue('staff@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive/oauth/callback?code=ABC',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const row = await prisma.integration.findUnique({
      where: { type: 'google_drive' },
    });
    expect(row).not.toBeNull();
    const creds = row!.creds as { accessToken: string; email: string };
    expect(creds.accessToken).toBe('new-AT');
    expect(creds.email).toBe('staff@example.com');
  });

  it('returns 400 when code is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive/oauth/callback',
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts -t oauth
```
Expected: FAIL — endpoint 未実装。

- [ ] **Step 3: 実装追加**

`server/src/routes/integrations-drive.ts` を以下に置換：

```ts
import type { FastifyInstance } from 'fastify';
import {
  getIntegration,
  deleteIntegration,
  upsertIntegration,
} from '../services/integration-service.js';
import * as drive from '../services/drive-service.js';
import { prisma } from '../lib/prisma.js';

export async function integrationsDriveRoutes(app: FastifyInstance) {
  app.get('/api/integrations/drive', async () => {
    const row = await getIntegration('google_drive');
    if (!row) return { connected: false };
    const creds = row.creds as { email?: string };
    const settings = row.settings as { rootFolderId?: string };
    const channel = await prisma.driveWatchChannel.findFirst();
    return {
      connected: true,
      email: creds.email ?? null,
      rootFolderId: settings.rootFolderId ?? null,
      status: row.status,
      watchExpiresAt: channel?.expiresAt ?? null,
    };
  });

  app.delete('/api/integrations/drive', async () => {
    await prisma.driveWatchChannel.deleteMany();
    await prisma.driveFolderMapping.deleteMany();
    await deleteIntegration('google_drive');
    return { ok: true };
  });

  app.get('/api/integrations/drive/oauth/authorize', async (_req, reply) => {
    const url = drive.buildAuthorizeUrl();
    reply.redirect(url);
    return reply;
  });

  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/api/integrations/drive/oauth/callback',
    async (req, reply) => {
      if (req.query.error) {
        reply.code(400);
        return { error: { code: 'OAUTH_ERROR', message: req.query.error } };
      }
      if (!req.query.code) {
        reply.code(400);
        return { error: { code: 'INVALID_BODY', message: 'code is required' } };
      }
      const tokens = await drive.exchangeCode(req.query.code);
      const email = await drive.getUserEmail(tokens.accessToken);
      const existing = await getIntegration('google_drive');
      const existingSettings = existing
        ? (existing.settings as object)
        : {};
      await upsertIntegration({
        type: 'google_drive',
        creds: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresIn
            ? Date.now() + tokens.expiresIn * 1000
            : undefined,
          scope: tokens.scope,
          email,
        },
        settings: existingSettings,
      });
      reply
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Drive 連携完了</title>` +
            `<h1>Drive 連携完了</h1>` +
            `<p>${escapeHtml(email ?? '(email 取得失敗)')} のトークンを保存しました。</p>` +
            `<p><a href="/">ダッシュボードへ戻る</a></p>`,
        );
      return reply;
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

- [ ] **Step 4: テストパス**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts
```
Expected: 全 6 ケース PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/integrations-drive.ts server/tests/routes/integrations-drive.test.ts
git commit -m "feat(spec 13): Drive OAuth authorize + callback endpoints

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: mappings CRUD と folders / settings endpoints

**Files:**
- Modify: `server/src/routes/integrations-drive.ts`
- Modify: `server/tests/routes/integrations-drive.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/routes/integrations-drive.test.ts` の末尾に追加：

```ts
describe('GET /api/integrations/drive/folders', () => {
  it('returns subfolders from the configured root', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: { rootFolderId: 'ROOT' },
    });
    vi.spyOn(driveService, 'listSubfolders').mockResolvedValue([
      { id: 'F1', name: '青山デザイン' },
      { id: 'F2', name: '橋本商店' },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive/folders',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: 'F1', name: '青山デザイン' },
      { id: 'F2', name: '橋本商店' },
    ]);
  });

  it('returns 401 when not configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive/folders',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /api/integrations/drive/settings', () => {
  it('updates rootFolderId in settings', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: {},
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/integrations/drive/settings',
      payload: { rootFolderId: 'NEW_ROOT' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.integration.findUnique({
      where: { type: 'google_drive' },
    });
    expect((row!.settings as { rootFolderId: string }).rootFolderId).toBe(
      'NEW_ROOT',
    );
  });
});

describe('mappings CRUD', () => {
  it('GET returns empty array when no mappings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/drive/mappings',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST creates a mapping', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/mappings',
      payload: {
        driveFolderId: 'F1',
        folderName: '青山デザイン',
        clientId: 'aoyama-design',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.driveFolderId).toBe('F1');
    expect(body.clientId).toBe('aoyama-design');
  });

  it('DELETE removes a mapping', async () => {
    const created = await prisma.driveFolderMapping.create({
      data: {
        driveFolderId: 'F1',
        folderName: 'X',
        clientId: 'aoyama-design',
      },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/drive/mappings/${created.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.driveFolderMapping.count()).toBe(0);
  });
});
```

- [ ] **Step 2: テスト失敗確認**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts
```
Expected: 新しい 6 ケースが FAIL（404）。

- [ ] **Step 3: ルートに以下を追加（`/oauth/callback` の直後に）**

```ts
  app.get('/api/integrations/drive/folders', async (_req, reply) => {
    const row = await getIntegration('google_drive');
    if (!row) {
      reply.code(401);
      return { error: { code: 'NOT_CONNECTED', message: 'drive not configured' } };
    }
    const creds = row.creds as { accessToken: string };
    const settings = row.settings as { rootFolderId?: string };
    if (!settings.rootFolderId) {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: 'rootFolderId not set' } };
    }
    return drive.listSubfolders(creds.accessToken, settings.rootFolderId);
  });

  app.put<{ Body: { rootFolderId?: string; importedSubfolderName?: string } }>(
    '/api/integrations/drive/settings',
    async (req, reply) => {
      const row = await getIntegration('google_drive');
      if (!row) {
        reply.code(401);
        return { error: { code: 'NOT_CONNECTED', message: 'drive not configured' } };
      }
      const old = row.settings as Record<string, unknown>;
      const next = { ...old, ...(req.body ?? {}) };
      await prisma.integration.update({
        where: { type: 'google_drive' },
        data: { settings: next as object },
      });
      return { ok: true };
    },
  );

  app.get('/api/integrations/drive/mappings', async () => {
    return prisma.driveFolderMapping.findMany({
      orderBy: { createdAt: 'desc' },
    });
  });

  app.post<{
    Body: { driveFolderId?: string; folderName?: string; clientId?: string };
  }>('/api/integrations/drive/mappings', async (req, reply) => {
    const { driveFolderId, folderName, clientId } = req.body ?? {};
    if (!driveFolderId || !folderName || !clientId) {
      reply.code(400);
      return {
        error: {
          code: 'INVALID_BODY',
          message: 'driveFolderId, folderName, clientId required',
        },
      };
    }
    const row = await prisma.driveFolderMapping.create({
      data: { driveFolderId, folderName, clientId },
    });
    reply.code(201);
    return row;
  });

  app.delete<{ Params: { id: string } }>(
    '/api/integrations/drive/mappings/:id',
    async (req, reply) => {
      const result = await prisma.driveFolderMapping.deleteMany({
        where: { id: req.params.id },
      });
      if (result.count === 0) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: 'mapping not found' } };
      }
      return { ok: true };
    },
  );
```

- [ ] **Step 4: テストパス**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts
```
Expected: 全 12 ケース PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/integrations-drive.ts server/tests/routes/integrations-drive.test.ts
git commit -m "feat(spec 13): folders / settings / mappings CRUD endpoints

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: sync / webhook / watch renew endpoints

**Files:**
- Modify: `server/src/routes/integrations-drive.ts`
- Modify: `server/tests/routes/integrations-drive.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`server/tests/routes/integrations-drive.test.ts` の末尾に追加：

```ts
import * as driveImporter from '../../src/services/drive-importer.js';

describe('POST /api/integrations/drive/sync', () => {
  it('calls syncDriveChanges and returns its result', async () => {
    vi.spyOn(driveImporter, 'syncDriveChanges').mockResolvedValue({
      trigger: 'manual',
      scanned: 5,
      imported: 3,
      skipped: 1,
      failed: 1,
      lastPageToken: 'PT9',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/sync',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      scanned: 5,
      imported: 3,
      skipped: 1,
      failed: 1,
    });
  });
});

describe('POST /api/integrations/drive/webhook', () => {
  it('returns 200 no-op for X-Goog-Resource-State=sync', async () => {
    await prisma.driveWatchChannel.create({
      data: {
        channelId: 'CH1',
        resourceId: 'r',
        pageToken: 'PT0',
        expiresAt: new Date(Date.now() + 1_000_000),
      },
    });
    const importerSpy = vi.spyOn(driveImporter, 'syncDriveChanges');
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/webhook',
      headers: {
        'x-goog-channel-id': 'CH1',
        'x-goog-resource-state': 'sync',
        'x-goog-resource-id': 'r',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(importerSpy).not.toHaveBeenCalled();
  });

  it('returns 404 when channelId is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/webhook',
      headers: {
        'x-goog-channel-id': 'UNKNOWN',
        'x-goog-resource-state': 'change',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('schedules sync (fire-and-forget) on resource state != sync', async () => {
    await prisma.driveWatchChannel.create({
      data: {
        channelId: 'CH2',
        resourceId: 'r2',
        pageToken: 'PT0',
        expiresAt: new Date(Date.now() + 1_000_000),
      },
    });
    const importerSpy = vi
      .spyOn(driveImporter, 'syncDriveChanges')
      .mockResolvedValue({
        trigger: 'webhook',
        scanned: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        lastPageToken: 'PT0',
      });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/webhook',
      headers: {
        'x-goog-channel-id': 'CH2',
        'x-goog-resource-state': 'change',
        'x-goog-resource-id': 'r2',
      },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(importerSpy).toHaveBeenCalledOnce();
    expect(importerSpy.mock.calls[0][0]).toEqual({ trigger: 'webhook' });
  });
});

describe('POST /api/integrations/drive/watch/renew', () => {
  it('replaces the existing watch channel', async () => {
    await upsertIntegration({
      type: 'google_drive',
      creds: { accessToken: 'A' },
      settings: {},
    });
    await prisma.driveWatchChannel.create({
      data: {
        channelId: 'OLD',
        resourceId: 'old-r',
        pageToken: 'PT0',
        expiresAt: new Date(Date.now() + 1_000),
      },
    });
    vi.spyOn(driveService, 'startWatch').mockResolvedValue({
      channelId: 'NEW',
      resourceId: 'new-r',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const stopSpy = vi.spyOn(driveService, 'stopWatch').mockResolvedValue();

    // need GOOGLE_DRIVE_WEBHOOK_BASE_URL set
    process.env.GOOGLE_DRIVE_WEBHOOK_BASE_URL = 'https://zeimee.example.com';
    const { __resetEnvCache } = await import('../../src/env.js');
    __resetEnvCache();

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/watch/renew',
    });
    expect(res.statusCode).toBe(200);
    expect(stopSpy).toHaveBeenCalledWith({
      accessToken: 'A',
      channelId: 'OLD',
      resourceId: 'old-r',
    });
    const channels = await prisma.driveWatchChannel.findMany();
    expect(channels).toHaveLength(1);
    expect(channels[0].channelId).toBe('NEW');

    delete process.env.GOOGLE_DRIVE_WEBHOOK_BASE_URL;
    __resetEnvCache();
  });
});
```

- [ ] **Step 2: テスト失敗確認**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts
```
Expected: 新しい 5 ケースが FAIL（404）。

- [ ] **Step 3: route 追加**

`server/src/routes/integrations-drive.ts` のファイル先頭の import に追加：

```ts
import { env } from '../env.js';
import { syncDriveChanges } from '../services/drive-importer.js';
```

`integrationsDriveRoutes` 関数の末尾に追加：

```ts
  app.post('/api/integrations/drive/sync', async () => {
    return syncDriveChanges({ trigger: 'manual' });
  });

  app.post('/api/integrations/drive/webhook', async (req, reply) => {
    const channelId = req.headers['x-goog-channel-id'];
    const resourceState = req.headers['x-goog-resource-state'];
    if (typeof channelId !== 'string') {
      reply.code(400);
      return { error: { code: 'INVALID_BODY', message: 'channel id missing' } };
    }
    const channel = await prisma.driveWatchChannel.findUnique({
      where: { channelId },
    });
    if (!channel) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'unknown channel' } };
    }
    if (resourceState === 'sync') {
      return { ok: true };
    }
    setImmediate(() => {
      syncDriveChanges({ trigger: 'webhook' }).catch(() => {});
    });
    return { ok: true };
  });

  app.post('/api/integrations/drive/watch/renew', async (_req, reply) => {
    const row = await getIntegration('google_drive');
    if (!row) {
      reply.code(401);
      return { error: { code: 'NOT_CONNECTED', message: 'drive not configured' } };
    }
    if (!env.GOOGLE_DRIVE_WEBHOOK_BASE_URL) {
      reply.code(400);
      return {
        error: {
          code: 'WEBHOOK_BASE_URL_MISSING',
          message: 'GOOGLE_DRIVE_WEBHOOK_BASE_URL is not configured',
        },
      };
    }
    const creds = row.creds as { accessToken: string };
    const channel = await prisma.driveWatchChannel.findFirst();
    if (channel?.resourceId) {
      try {
        await drive.stopWatch({
          accessToken: creds.accessToken,
          channelId: channel.channelId,
          resourceId: channel.resourceId,
        });
      } catch {
        // best-effort
      }
    }
    const startToken = channel?.pageToken
      ? channel.pageToken
      : await drive.getStartPageToken(creds.accessToken);
    const result = await drive.startWatch({
      accessToken: creds.accessToken,
      pageToken: startToken,
      webhookUrl: `${env.GOOGLE_DRIVE_WEBHOOK_BASE_URL}/api/integrations/drive/webhook`,
    });
    await prisma.driveWatchChannel.deleteMany();
    await prisma.driveWatchChannel.create({
      data: {
        channelId: result.channelId,
        resourceId: result.resourceId,
        pageToken: startToken,
        expiresAt: result.expiresAt,
      },
    });
    return { ok: true, channelId: result.channelId, expiresAt: result.expiresAt };
  });
```

- [ ] **Step 4: テストパス**

Run:
```bash
cd server && npx vitest run tests/routes/integrations-drive.test.ts
```
Expected: 全 17 ケース PASS。

- [ ] **Step 5: 全テスト走らせて他に壊れていないことを確認**

Run:
```bash
cd server && npm test
```
Expected: 全テスト PASS（既存も含む）。

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/integrations-drive.ts server/tests/routes/integrations-drive.test.ts
git commit -m "feat(spec 13): sync / webhook / watch renew endpoints

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: フロントエンド — 左ナビとビューコンテナ

**Files:**
- Modify: `index.html`
- Modify: `script.js`
- Modify: `styles.css`

- [ ] **Step 1: 左ナビに項目を追加**

`index.html` を Read して、既存のナビ項目（`data-view="vouchers-register"` 等）の近くに、以下のリンクを追加：

```html
<a href="#" class="nav-link" data-view="integrations-drive">連携 / Drive</a>
```

並び順は「証憑登録」の下が自然。

- [ ] **Step 2: ビューコンテナを追加**

同じく `index.html` の `<section data-view="...">` が並ぶエリアに、以下を追加：

```html
<section data-view="integrations-drive" hidden>
  <div class="integration-drive-connection"></div>
  <div class="drive-folder-mappings"></div>
  <div class="drive-sync"></div>
</section>
```

- [ ] **Step 3: 最小 CSS を追加**

`styles.css` 末尾に：

```css
.integration-drive-connection,
.drive-folder-mappings,
.drive-sync {
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.drive-mapping-row {
  display: grid;
  grid-template-columns: 1fr 200px auto;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f3f4f6;
}
.voucher-source-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}
```

- [ ] **Step 4: appState 拡張**

`script.js` の `const appState = {...}` を grep で探し、以下のキーを追加：

```js
  driveIntegration: null,
  driveFolders: [],
  driveMappings: [],
  driveLastSync: null,
```

- [ ] **Step 5: renderView ハンドラを追加**

`script.js` の `renderView` オブジェクト（または switch）に：

```js
  "integrations-drive": () => renderIntegrationsDrive(),
```

そして `renderIntegrationsDrive` の最小スタブを追加（次タスクで中身）：

```js
async function renderIntegrationsDrive() {
  const container = document.querySelector('section[data-view="integrations-drive"]');
  if (!container) return;
  container.innerHTML = '<p>読み込み中…</p>';
  await loadDriveIntegration();
  // 中身の DOM 構築は Task 15-17 で書く
}
async function loadDriveIntegration() {
  const res = await fetch('/api/integrations/drive');
  appState.driveIntegration = await res.json();
}
```

- [ ] **Step 6: 手動確認 — 起動して左ナビからビュー切替**

Run:
```bash
cd server && npm run dev
```
別ターミナルで `http://localhost:3000` を開き、左ナビ「連携 / Drive」をクリック → 空のコンテナが表示されることを目視確認。

- [ ] **Step 7: Commit**

```bash
git add index.html script.js styles.css
git commit -m "feat(spec 13): frontend nav and empty container for integrations-drive

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 15: フロント — 接続パネル

**Files:**
- Modify: `script.js`

- [ ] **Step 1: 接続パネルを実装**

`script.js` の `renderIntegrationsDrive` を以下に置き換え：

```js
async function renderIntegrationsDrive() {
  const container = document.querySelector('section[data-view="integrations-drive"]');
  if (!container) return;
  await loadDriveIntegration();
  const integ = appState.driveIntegration;
  const conn = container.querySelector('.integration-drive-connection');
  if (!integ.connected) {
    conn.innerHTML =
      '<h2>Google Drive 連携</h2>' +
      '<p>未接続です。</p>' +
      '<a class="btn btn-primary" href="/api/integrations/drive/oauth/authorize">Google Drive と連携</a>';
  } else {
    conn.innerHTML =
      '<h2>Google Drive 連携</h2>' +
      `<p>接続中: <strong>${escapeHtmlText(integ.email ?? '(不明)')}</strong></p>` +
      `<p>状態: ${escapeHtmlText(integ.status ?? 'ok')}</p>` +
      `<p>watch 期限: ${integ.watchExpiresAt ? new Date(integ.watchExpiresAt).toLocaleString() : '未設定'}</p>` +
      `<div class="root-folder-config">` +
        `<label>ルートフォルダ ID: <input type="text" id="drive-root-folder" value="${escapeHtmlAttr(integ.rootFolderId ?? '')}"></label>` +
        `<button id="drive-save-root">保存</button>` +
      `</div>` +
      `<button id="drive-disconnect" class="btn">切断</button>`;
    document.getElementById('drive-save-root').addEventListener('click', saveDriveRootFolder);
    document.getElementById('drive-disconnect').addEventListener('click', disconnectDrive);
  }
}

function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtmlAttr(s) {
  return escapeHtmlText(s).replace(/"/g, '&quot;');
}

async function saveDriveRootFolder() {
  const id = document.getElementById('drive-root-folder').value.trim();
  await fetch('/api/integrations/drive/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootFolderId: id }),
  });
  renderIntegrationsDrive();
}

async function disconnectDrive() {
  if (!confirm('Drive 連携を切断します。よろしいですか？')) return;
  await fetch('/api/integrations/drive', { method: 'DELETE' });
  renderIntegrationsDrive();
}
```

- [ ] **Step 2: 手動確認**

`npm run dev` 起動中なら自動リロード。ブラウザで「連携 / Drive」を開き：
- 未接続: 「Google Drive と連携」ボタンが見える（クリックすると 302 リダイレクトで Google 画面へ → クライアントなしでは error_invalid_client が出るが、OAuth 設定後は通る）
- 接続済（手動で `prisma studio` から Integration を追加してテスト）: 接続メールと「切断」ボタンが見える

- [ ] **Step 3: Commit**

```bash
git add script.js
git commit -m "feat(spec 13): drive connection panel UI

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 16: フロント — フォルダ mapping パネル

**Files:**
- Modify: `script.js`

- [ ] **Step 1: mapping パネルを実装**

`script.js` の `renderIntegrationsDrive` の中の `conn.innerHTML = ...` ブロック（接続済）の処理直後に、以下のコードを追加：

```js
    await loadDriveFolders();
    await loadDriveMappings();
    await loadClientList();
    const mapPane = container.querySelector('.drive-folder-mappings');
    mapPane.innerHTML =
      '<h2>フォルダ ↔ 顧問先 mapping</h2>' +
      appState.driveFolders.map((f) => {
        const existing = appState.driveMappings.find((m) => m.driveFolderId === f.id);
        const options = appState.clients.map((c) =>
          `<option value="${escapeHtmlAttr(c.id)}"${existing?.clientId === c.id ? ' selected' : ''}>${escapeHtmlText(c.name)}</option>`
        ).join('');
        return (
          `<div class="drive-mapping-row" data-folder-id="${escapeHtmlAttr(f.id)}" data-folder-name="${escapeHtmlAttr(f.name)}" data-mapping-id="${escapeHtmlAttr(existing?.id ?? '')}">` +
            `<span>${escapeHtmlText(f.name)}</span>` +
            `<select class="drive-mapping-select"><option value="">（未設定）</option>${options}</select>` +
            (existing ? '<button class="drive-mapping-delete">×</button>' : '<button class="drive-mapping-save">保存</button>') +
          `</div>`
        );
      }).join('');
    mapPane.querySelectorAll('.drive-mapping-save').forEach((btn) => {
      btn.addEventListener('click', saveDriveMapping);
    });
    mapPane.querySelectorAll('.drive-mapping-delete').forEach((btn) => {
      btn.addEventListener('click', deleteDriveMapping);
    });
```

そして以下のヘルパを追加：

```js
async function loadDriveFolders() {
  try {
    const res = await fetch('/api/integrations/drive/folders');
    if (!res.ok) {
      appState.driveFolders = [];
      return;
    }
    appState.driveFolders = await res.json();
  } catch {
    appState.driveFolders = [];
  }
}

async function loadDriveMappings() {
  const res = await fetch('/api/integrations/drive/mappings');
  appState.driveMappings = await res.json();
}

async function loadClientList() {
  if (!appState.clients || appState.clients.length === 0) {
    const res = await fetch('/api/clients');
    appState.clients = await res.json();
  }
}

async function saveDriveMapping(ev) {
  const row = ev.target.closest('.drive-mapping-row');
  const folderId = row.dataset.folderId;
  const folderName = row.dataset.folderName;
  const select = row.querySelector('.drive-mapping-select');
  const clientId = select.value;
  if (!clientId) return;
  await fetch('/api/integrations/drive/mappings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ driveFolderId: folderId, folderName, clientId }),
  });
  renderIntegrationsDrive();
}

async function deleteDriveMapping(ev) {
  const row = ev.target.closest('.drive-mapping-row');
  const id = row.dataset.mappingId;
  if (!id) return;
  if (!confirm('この mapping を削除します')) return;
  await fetch(`/api/integrations/drive/mappings/${id}`, { method: 'DELETE' });
  renderIntegrationsDrive();
}
```

- [ ] **Step 2: 手動確認**

ブラウザで「連携 / Drive」を開き、`/api/integrations/drive/folders` を spy なし（実環境では Drive 設定済が必要）でも `try/catch` で空配列になり「mapping 行が無い」表示が出ることを確認。

- [ ] **Step 3: Commit**

```bash
git add script.js
git commit -m "feat(spec 13): drive folder ↔ client mapping UI

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 17: フロント — 同期パネル + Voucher source バッジ

**Files:**
- Modify: `script.js`

- [ ] **Step 1: 同期パネルを実装**

`script.js` の `renderIntegrationsDrive` の接続済ブロックの末尾（mapping パネルの後）に追加：

```js
    const syncPane = container.querySelector('.drive-sync');
    const lastSync = appState.driveLastSync;
    syncPane.innerHTML =
      '<h2>同期</h2>' +
      '<button id="drive-sync-now" class="btn btn-primary">今すぐ同期</button>' +
      (lastSync
        ? `<p>最後の同期: scanned=${lastSync.scanned}, imported=${lastSync.imported}, skipped=${lastSync.skipped}, failed=${lastSync.failed}</p>`
        : '<p>まだ同期していません</p>');
    document.getElementById('drive-sync-now').addEventListener('click', triggerDriveSync);
```

そしてヘルパ：

```js
async function triggerDriveSync() {
  const btn = document.getElementById('drive-sync-now');
  btn.disabled = true;
  btn.textContent = '同期中…';
  try {
    const res = await fetch('/api/integrations/drive/sync', { method: 'POST' });
    appState.driveLastSync = await res.json();
  } finally {
    btn.disabled = false;
    btn.textContent = '今すぐ同期';
  }
  renderIntegrationsDrive();
}
```

- [ ] **Step 2: 既存の証憑登録ビューにバッジ追加**

`script.js` で `renderVoucherRegister`（または voucher card を組み立てる関数）を探して、card の innerHTML に以下を含める。voucher オブジェクトに `source` フィールドが入っているので：

```js
const sourceBadge = voucher.source === 'drive'
  ? '<span class="voucher-source-badge">Drive</span>'
  : '<span class="voucher-source-badge">手動</span>';
```

card の HTML を組み立てる文字列に、画像 `<img>` の親 div の中に上記 `sourceBadge` を入れる。位置は CSS の `.voucher-source-badge` で `position:absolute` してるので親 div に `position:relative` が要る — 既存 CSS を確認して必要なら `position: relative;` を追加。

- [ ] **Step 3: 手動確認**

`npm run dev` でブラウザを開き：
1. 「連携 / Drive」→「今すぐ同期」を押す → 結果オブジェクトが下に表示される
2. 「証憑登録」→ サムネに「手動」バッジが出る

- [ ] **Step 4: 全自動テストを最終確認**

Run:
```bash
cd server && npm test
```
Expected: 全テスト PASS。

- [ ] **Step 5: Commit**

```bash
git add script.js styles.css
git commit -m "feat(spec 13): drive sync panel + voucher source badge

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

実装完了時点で、spec の受入基準 12 項目に対応するタスクを再確認：

- [ ] **Prisma migrate で 3 テーブル + Voucher 列追加** → Task 1
- [ ] **OAuth で Integration 行が作られる** → Task 11
- [ ] **`/folders` でサブフォルダが取れる** → Task 12
- [ ] **mapping CRUD** → Task 12
- [ ] **「今すぐ同期」で Voucher 作成** → Task 7 + Task 13
- [ ] **再 sync で重複しない** → Task 8
- [ ] **取り込み済フォルダに move** → Task 7
- [ ] **HEIC / PDF / 11MB+ / 未 mapping は skip** → Task 8
- [ ] **move 失敗 → `driveImportStatus='move_failed'`** → Task 9
- [ ] **サーバテスト 11+ ケース** → Task 3-13（integration-service 10 + drive-importer 8 + routes 17 = 35 ケース、spec の最低 11 を大幅超過）
- [ ] **フロント疎通** → Task 14-17

---

## Execution Notes

- 既存方針に沿って **vi.mock は使わず `vi.spyOn` を service 関数に当てる** スタイルで統一しています（mf-api / voucher-service の慣習に合致）。
- フロントのテスト基盤は無いので Task 14-17 は手動確認のみ。
- watch renew の cron 自動化は spec 13 のスコープ外（手動 endpoint まで）。本番ではここを cron / scheduled task で叩く運用になります。
- Drive API のスコープは `drive` (フルアクセス) を採用。`drive.file` だと既存ファイルの move が不可なため。
