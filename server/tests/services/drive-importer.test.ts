import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { __resetEnvCache } from '../../src/env.js';
import * as driveService from '../../src/services/drive-service.js';
import * as integrationService from '../../src/services/integration-service.js';
import { syncDriveChanges } from '../../src/services/drive-importer.js';

const ROOT_FOLDER_ID = 'root-folder-1';
const MAPPED_FOLDER_ID = 'folder-mapped';
const IMPORTED_SUBFOLDER_ID = 'subfolder-imported';
const UNMAPPED_FOLDER_ID = 'folder-unmapped';

async function clearAll() {
  await prisma.voucher.deleteMany();
  await prisma.driveFolderMapping.deleteMany();
  await prisma.driveWatchChannel.deleteMany();
  await prisma.integration.deleteMany();
}

async function setupIntegration() {
  await prisma.integration.create({
    data: {
      firmId: 'demo-firm',
      type: 'google_drive',
      creds: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600_000,
        scope: '',
        email: 'tax@example.com',
      } as object,
      settings: { rootFolderId: ROOT_FOLDER_ID } as object,
      enabled: true,
      status: 'ok',
    },
  });
  // Seed an existing watch channel so syncDriveChanges does the real loop
  // (without one, the importer just persists startPageToken and returns).
  await prisma.driveWatchChannel.create({
    data: {
      firmId: 'demo-firm',
      channelId: 'channel-1',
      resourceId: 'resource-1',
      pageToken: 'page-token-initial',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  });
}

async function setupMapping() {
  await prisma.driveFolderMapping.create({
    data: {
      firmId: 'demo-firm',
      driveFolderId: MAPPED_FOLDER_ID,
      folderName: '青山デザイン_領収書',
      clientId: 'aoyama-design',
      importedSubfolderId: IMPORTED_SUBFOLDER_ID,
    },
  });
}

beforeEach(async () => {
  await clearAll();
  process.env.OPENAI_API_KEY = '';
  __resetEnvCache();
  vi.spyOn(integrationService, 'ensureDriveToken').mockResolvedValue('access');
  vi.spyOn(driveService, 'getFileBinary').mockResolvedValue({
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    mimeType: 'image/jpeg',
    name: 'IMG.jpg',
    size: 4,
    parents: [MAPPED_FOLDER_ID],
  });
  vi.spyOn(driveService, 'moveFile').mockResolvedValue(undefined);
  vi.spyOn(driveService, 'ensureImportedSubfolder').mockResolvedValue(
    IMPORTED_SUBFOLDER_ID,
  );
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
  vi.restoreAllMocks();
});

describe('syncDriveChanges', () => {
  it('creates a Voucher with source=drive and driveFileId set for a new change', async () => {
    await setupIntegration();
    await setupMapping();
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'file-1',
          removed: false,
          file: {
            id: 'file-1',
            name: 'IMG_0421.jpg',
            mimeType: 'image/jpeg',
            size: 1024,
            parents: [MAPPED_FOLDER_ID],
            trashed: false,
          },
        },
      ],
      nextPageToken: 'page-token-next',
    });

    const result = await syncDriveChanges({ trigger: 'manual' });

    expect(result.imported).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.lastPageToken).toBe('page-token-next');

    const v = await prisma.voucher.findUnique({
      where: { driveFileId: 'file-1' },
    });
    expect(v).not.toBeNull();
    expect(v?.source).toBe('drive');
    expect(v?.driveImportStatus).toBe('imported');
    expect(v?.clientId).toBe('aoyama-design');
    expect(v?.uploadedBy).toBe('drive');
  });

  it('skips changes that match an existing driveFileId (idempotent)', async () => {
    await setupIntegration();
    await setupMapping();
    await prisma.voucher.create({
      data: {
        firmId: 'demo-firm',
        clientId: 'aoyama-design',
        filename: 'old.jpg',
        mimeType: 'image/jpeg',
        size: 4,
        imageData: Buffer.from([0xff]),
        source: 'drive',
        driveFileId: 'file-dup',
        driveImportStatus: 'imported',
      },
    });
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'file-dup',
          removed: false,
          file: {
            id: 'file-dup',
            name: 'IMG.jpg',
            mimeType: 'image/jpeg',
            size: 1024,
            parents: [MAPPED_FOLDER_ID],
            trashed: false,
          },
        },
      ],
      nextPageToken: 'next',
    });

    const result = await syncDriveChanges({ trigger: 'manual' });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    const count = await prisma.voucher.count({
      where: { driveFileId: 'file-dup' },
    });
    expect(count).toBe(1);
  });

  it('skips files in unmapped subfolders', async () => {
    await setupIntegration();
    await setupMapping();
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'file-unmapped',
          removed: false,
          file: {
            id: 'file-unmapped',
            name: 'IMG.jpg',
            mimeType: 'image/jpeg',
            size: 1024,
            parents: [UNMAPPED_FOLDER_ID],
            trashed: false,
          },
        },
      ],
      nextPageToken: 'next',
    });

    const result = await syncDriveChanges({ trigger: 'manual' });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await prisma.voucher.count()).toBe(0);
  });

  it('skips files with disallowed MIME', async () => {
    await setupIntegration();
    await setupMapping();
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'file-heic',
          removed: false,
          file: {
            id: 'file-heic',
            name: 'IMG.heic',
            mimeType: 'image/heic',
            size: 1024,
            parents: [MAPPED_FOLDER_ID],
            trashed: false,
          },
        },
      ],
      nextPageToken: 'next',
    });

    const result = await syncDriveChanges({ trigger: 'manual' });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await prisma.voucher.count()).toBe(0);
  });

  it('skips files larger than 10MB', async () => {
    await setupIntegration();
    await setupMapping();
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'file-big',
          removed: false,
          file: {
            id: 'file-big',
            name: 'big.jpg',
            mimeType: 'image/jpeg',
            size: 11 * 1024 * 1024,
            parents: [MAPPED_FOLDER_ID],
            trashed: false,
          },
        },
      ],
      nextPageToken: 'next',
    });

    const result = await syncDriveChanges({ trigger: 'manual' });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await prisma.voucher.count()).toBe(0);
  });

  it('leaves Voucher with driveImportStatus=move_failed when moveFile throws', async () => {
    await setupIntegration();
    await setupMapping();
    vi.spyOn(driveService, 'listChanges').mockResolvedValue({
      changes: [
        {
          fileId: 'file-mv',
          removed: false,
          file: {
            id: 'file-mv',
            name: 'IMG.jpg',
            mimeType: 'image/jpeg',
            size: 1024,
            parents: [MAPPED_FOLDER_ID],
            trashed: false,
          },
        },
      ],
      nextPageToken: 'next',
    });
    vi.spyOn(driveService, 'moveFile').mockRejectedValue(
      new Error('drive move 500'),
    );

    const result = await syncDriveChanges({ trigger: 'manual' });

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);

    const v = await prisma.voucher.findUnique({
      where: { driveFileId: 'file-mv' },
    });
    expect(v).not.toBeNull();
    expect(v?.driveImportStatus).toBe('move_failed');
    expect(v?.source).toBe('drive');
  });
});
