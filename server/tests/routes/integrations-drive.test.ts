import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  vi,
} from 'vitest';
import { buildApp } from '../../src/server.js';
import { prisma } from '../../src/lib/prisma.js';
import { __resetEnvCache } from '../../src/env.js';
import * as driveImporter from '../../src/services/drive-importer.js';

const app = await buildApp();

async function clearAll() {
  await prisma.voucher.deleteMany();
  await prisma.driveFolderMapping.deleteMany();
  await prisma.driveWatchChannel.deleteMany();
  await prisma.integration.deleteMany();
}

beforeEach(async () => {
  await clearAll();
  __resetEnvCache();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await clearAll();
  await app.close();
});

describe('POST /api/integrations/drive/mappings', () => {
  it('creates a mapping row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/mappings',
      payload: {
        driveFolderId: 'folder-aoyama',
        folderName: '青山デザイン_領収書',
        clientId: 'aoyama-design',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.driveFolderId).toBe('folder-aoyama');
    expect(body.clientId).toBe('aoyama-design');
    const row = await prisma.driveFolderMapping.findUnique({
      where: { driveFolderId: 'folder-aoyama' },
    });
    expect(row).not.toBeNull();
  });
});

describe('DELETE /api/integrations/drive/mappings/:id', () => {
  it('removes the mapping row', async () => {
    const created = await prisma.driveFolderMapping.create({
      data: {
        driveFolderId: 'folder-delete',
        folderName: 'delete-me',
        clientId: 'shibuya-cafe',
      },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/drive/mappings/${created.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const after = await prisma.driveFolderMapping.findUnique({
      where: { id: created.id },
    });
    expect(after).toBeNull();
  });
});

describe('POST /api/integrations/drive/webhook', () => {
  it('returns 404 when X-Goog-Channel-ID does not match', async () => {
    await prisma.driveWatchChannel.create({
      data: {
        channelId: 'channel-known',
        resourceId: 'res',
        pageToken: 'pt',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const spy = vi
      .spyOn(driveImporter, 'syncDriveChanges')
      .mockResolvedValue({
        trigger: 'webhook',
        scanned: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        lastPageToken: 'pt',
      });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/webhook',
      headers: {
        'x-goog-channel-id': 'channel-wrong',
        'x-goog-resource-state': 'update',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 200 no-op when X-Goog-Resource-State=sync', async () => {
    await prisma.driveWatchChannel.create({
      data: {
        channelId: 'channel-sync',
        resourceId: 'res',
        pageToken: 'pt',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const spy = vi
      .spyOn(driveImporter, 'syncDriveChanges')
      .mockResolvedValue({
        trigger: 'webhook',
        scanned: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        lastPageToken: 'pt',
      });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/webhook',
      headers: {
        'x-goog-channel-id': 'channel-sync',
        'x-goog-resource-state': 'sync',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await new Promise((r) => setImmediate(r));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/drive/sync', () => {
  it('returns the importer result when integration is connected', async () => {
    await prisma.integration.create({
      data: {
        type: 'google_drive',
        creds: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: Date.now() + 3600_000,
          scope: '',
          email: 'tax@example.com',
        } as object,
        settings: {} as object,
        enabled: true,
        status: 'ok',
      },
    });
    const spy = vi
      .spyOn(driveImporter, 'syncDriveChanges')
      .mockResolvedValue({
        trigger: 'manual',
        scanned: 3,
        imported: 2,
        skipped: 1,
        failed: 0,
        lastPageToken: 'tok-after',
      });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/drive/sync',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      trigger: 'manual',
      scanned: 3,
      imported: 2,
      skipped: 1,
      failed: 0,
      lastPageToken: 'tok-after',
    });
    expect(spy).toHaveBeenCalledOnce();
  });
});
