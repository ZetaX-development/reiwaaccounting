import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import {
  getDriveIntegration,
  ensureDriveToken,
  type DriveSettings,
} from './integration-service.js';
import * as driveService from './drive-service.js';
import type { DriveChangeFile } from './drive-service.js';
import { createVoucher, runOcrForVoucher } from './voucher-service.js';

// ---------------------------------------------------------------------------
// drive-importer: pulls changes from Google Drive, creates Vouchers, then
// moves processed files into a "取り込み済" subfolder. spec 15 §`syncDriveChanges`.
// ---------------------------------------------------------------------------

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const MAX_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_IMPORTED_SUBFOLDER_NAME = '取り込み済';

export interface SyncDriveResult {
  trigger: 'manual' | 'webhook';
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  lastPageToken: string;
}

export async function syncDriveChanges(opts?: {
  trigger?: 'manual' | 'webhook';
}): Promise<SyncDriveResult> {
  const trigger = opts?.trigger ?? 'manual';
  const empty: SyncDriveResult = {
    trigger,
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    lastPageToken: '',
  };

  const integration = await getDriveIntegration();
  if (!integration) return empty;

  const token = await ensureDriveToken();
  const settings = (integration.settings as DriveSettings | null) ?? {};
  const importedSubfolderName =
    settings.importedSubfolderName?.trim() || DEFAULT_IMPORTED_SUBFOLDER_NAME;

  // First run: persist current startPageToken and bail out without
  // back-filling historic files (spec design line 224-225).
  let watch = await prisma.driveWatchChannel.findFirst({
    orderBy: { createdAt: 'desc' },
  });
  if (!watch) {
    const startPageToken = await driveService.getStartPageToken(token);
    watch = await prisma.driveWatchChannel.create({
      data: {
        firmId: 'demo-firm',
        channelId: cryptoRandomId(),
        resourceId: '',
        pageToken: startPageToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    return { ...empty, lastPageToken: startPageToken };
  }

  const mappings = await prisma.driveFolderMapping.findMany();
  const mappingByFolderId = new Map(
    mappings.map((m) => [m.driveFolderId, m]),
  );

  let scanned = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let pageToken = watch.pageToken;

  const { changes, nextPageToken } = await driveService.listChanges(
    token,
    pageToken,
  );
  pageToken = nextPageToken;

  for (const change of changes) {
    scanned++;
    const file = change.file;
    if (!file) {
      skipped++;
      continue;
    }
    if (change.removed || file.trashed) {
      skipped++;
      continue;
    }
    // Find a mapping among parents.
    let mapping = null;
    for (const parentId of file.parents) {
      const m = mappingByFolderId.get(parentId);
      if (m) {
        mapping = m;
        break;
      }
    }
    if (!mapping) {
      skipped++;
      continue;
    }
    // Already imported (driveFileId unique).
    const dup = await prisma.voucher.findUnique({
      where: { driveFileId: file.id },
      select: { id: true },
    });
    if (dup) {
      skipped++;
      continue;
    }
    if (!ALLOWED_MIMES.has(file.mimeType)) {
      skipped++;
      continue;
    }
    if (file.size > MAX_SIZE_BYTES) {
      skipped++;
      continue;
    }

    // Pull binary + create Voucher.
    let createdVoucherId: string | null = null;
    try {
      const blob = await driveService.getFileBinary(token, file.id);
      if (blob.size > MAX_SIZE_BYTES || blob.buffer.byteLength > MAX_SIZE_BYTES) {
        skipped++;
        continue;
      }
      const meta = await createVoucher({
        clientId: mapping.clientId,
        filename: file.name || blob.name || file.id,
        mimeType: file.mimeType || blob.mimeType,
        buffer: blob.buffer,
        uploadedBy: 'drive',
      });
      createdVoucherId = meta.id;
      await prisma.voucher.update({
        where: { id: meta.id },
        data: {
          source: 'drive',
          driveFileId: file.id,
          driveImportStatus: 'imported',
        },
      });
    } catch (err) {
      logger.warn({ err, fileId: file.id }, 'drive: voucher creation failed');
      failed++;
      continue;
    }

    // Move on Drive — ensure subfolder, then update parents.
    try {
      let importedSubfolderId = mapping.importedSubfolderId;
      if (!importedSubfolderId) {
        importedSubfolderId = await driveService.ensureImportedSubfolder(
          token,
          mapping.driveFolderId,
          importedSubfolderName,
        );
        await prisma.driveFolderMapping.update({
          where: { id: mapping.id },
          data: { importedSubfolderId },
        });
      }
      await driveService.moveFile(
        token,
        file.id,
        importedSubfolderId,
        mapping.driveFolderId,
      );
      imported++;
    } catch (err) {
      logger.warn({ err, fileId: file.id }, 'drive: move failed');
      if (createdVoucherId) {
        await prisma.voucher.update({
          where: { id: createdVoucherId },
          data: { driveImportStatus: 'move_failed' },
        });
      }
      failed++;
      continue;
    }

    // Kick OCR fire-and-forget (mirrors voucher route behaviour).
    if (env.OPENAI_API_KEY && createdVoucherId) {
      const vid = createdVoucherId;
      setImmediate(() => {
        runOcrForVoucher(vid).catch(() => {});
      });
    }
  }

  // Persist the latest pageToken regardless of per-file failures.
  await prisma.driveWatchChannel.update({
    where: { id: watch.id },
    data: { pageToken },
  });

  return {
    trigger,
    scanned,
    imported,
    skipped,
    failed,
    lastPageToken: pageToken,
  };
}

// ---------------------------------------------------------------------------
// backfillDriveFiles: マッピング済みフォルダの既存ファイルを一括取り込む
// ---------------------------------------------------------------------------

export interface BackfillResult {
  imported: number;
  skipped: number;
  failed: number;
}

export async function backfillDriveFiles(): Promise<BackfillResult> {
  const integration = await getDriveIntegration();
  if (!integration) return { imported: 0, skipped: 0, failed: 0 };

  const token = await ensureDriveToken();
  const settings = (integration.settings as DriveSettings | null) ?? {};
  const importedSubfolderName =
    settings.importedSubfolderName?.trim() || DEFAULT_IMPORTED_SUBFOLDER_NAME;

  const mappings = await prisma.driveFolderMapping.findMany();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const mapping of mappings) {
    let files: DriveChangeFile[];
    try {
      files = await driveService.listFilesInFolder(token, mapping.driveFolderId);
    } catch (err) {
      logger.warn({ err, folderId: mapping.driveFolderId }, 'backfill: listFilesInFolder failed');
      failed++;
      continue;
    }

    for (const file of files) {
      // 既取込みチェック
      const dup = await prisma.voucher.findUnique({
        where: { driveFileId: file.id },
        select: { id: true },
      });
      if (dup) { skipped++; continue; }
      if (!ALLOWED_MIMES.has(file.mimeType)) { skipped++; continue; }
      if (file.size > MAX_SIZE_BYTES) { skipped++; continue; }

      let createdVoucherId: string | null = null;
      try {
        const blob = await driveService.getFileBinary(token, file.id);
        if (blob.buffer.byteLength > MAX_SIZE_BYTES) { skipped++; continue; }
        const meta = await createVoucher({
          clientId: mapping.clientId,
          filename: file.name || file.id,
          mimeType: file.mimeType || blob.mimeType,
          buffer: blob.buffer,
          uploadedBy: 'drive',
        });
        createdVoucherId = meta.id;
        await prisma.voucher.update({
          where: { id: meta.id },
          data: { source: 'drive', driveFileId: file.id, driveImportStatus: 'imported' },
        });
      } catch (err) {
        logger.warn({ err, fileId: file.id }, 'backfill: voucher creation failed');
        failed++;
        continue;
      }

      // Drive 上のファイルを取り込み済みフォルダへ移動
      try {
        let importedSubfolderId = mapping.importedSubfolderId;
        if (!importedSubfolderId) {
          importedSubfolderId = await driveService.ensureImportedSubfolder(
            token, mapping.driveFolderId, importedSubfolderName,
          );
          await prisma.driveFolderMapping.update({
            where: { id: mapping.id },
            data: { importedSubfolderId },
          });
        }
        await driveService.moveFile(token, file.id, importedSubfolderId, mapping.driveFolderId);
        imported++;
      } catch (err) {
        logger.warn({ err, fileId: file.id }, 'backfill: move failed');
        if (createdVoucherId) {
          await prisma.voucher.update({
            where: { id: createdVoucherId },
            data: { driveImportStatus: 'move_failed' },
          });
        }
        failed++;
        continue;
      }

      // OCR キック
      if (env.OPENAI_API_KEY && createdVoucherId) {
        const vid = createdVoucherId;
        setImmediate(() => { runOcrForVoucher(vid).catch(() => {}); });
      }
    }
  }

  return { imported, skipped, failed };
}

function cryptoRandomId(): string {
  // node:crypto.randomUUID is available without import via globalThis
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
