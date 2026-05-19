import type { Integration } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { refreshAccessToken } from './drive-service.js';

// ---------------------------------------------------------------------------
// Integration table CRUD + ensureDriveToken (spec 15)
// Mirrors the refresh-on-near-expiry pattern from adapters/mf-api.ts:ensureToken.
// ---------------------------------------------------------------------------

const DRIVE_TYPE = 'google_drive';

export interface DriveCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  scope: string;
  email: string;
}

export interface DriveSettings {
  rootFolderId?: string;
  rootFolderName?: string;
  importedSubfolderName?: string;
}

export async function getDriveIntegration(): Promise<Integration | null> {
  return prisma.integration.findUnique({ where: { type: DRIVE_TYPE } });
}

export async function upsertDriveIntegration(
  creds: DriveCreds,
  settings?: DriveSettings,
): Promise<Integration> {
  const existing = await prisma.integration.findUnique({
    where: { type: DRIVE_TYPE },
  });
  const mergedSettings =
    settings ?? (existing?.settings as DriveSettings | null) ?? {};
  return prisma.integration.upsert({
    where: { type: DRIVE_TYPE },
    create: {
      type: DRIVE_TYPE,
      creds: creds as unknown as object,
      settings: mergedSettings as unknown as object,
      enabled: true,
      status: 'ok',
    },
    update: {
      creds: creds as unknown as object,
      settings: mergedSettings as unknown as object,
      enabled: true,
      status: 'ok',
    },
  });
}

export async function updateDriveSettings(
  settings: DriveSettings,
): Promise<Integration | null> {
  const existing = await prisma.integration.findUnique({
    where: { type: DRIVE_TYPE },
  });
  if (!existing) return null;
  const current = (existing.settings as DriveSettings | null) ?? {};
  const merged = { ...current, ...settings };
  return prisma.integration.update({
    where: { type: DRIVE_TYPE },
    data: { settings: merged as unknown as object },
  });
}

export async function deleteDriveIntegration(): Promise<void> {
  await prisma.integration.deleteMany({ where: { type: DRIVE_TYPE } });
}

export async function markStatus(
  status: 'ok' | 'reauth_required' | 'watch_failed',
): Promise<void> {
  await prisma.integration.updateMany({
    where: { type: DRIVE_TYPE },
    data: { status },
  });
}

/**
 * Returns a valid access token, refreshing via Google OAuth when the cached
 * token is within 60 seconds of expiry. Persists the refreshed creds.
 *
 * Throws if no Integration row exists or if refresh fails (also flips status
 * to `reauth_required` so the UI can surface a banner).
 */
export async function ensureDriveToken(): Promise<string> {
  const row = await getDriveIntegration();
  if (!row) {
    throw new Error('Drive integration not connected');
  }
  const creds = row.creds as unknown as DriveCreds;
  const expiringSoon =
    !creds.expiresAt || creds.expiresAt - Date.now() < 60_000;
  if (!expiringSoon) return creds.accessToken;
  if (!creds.refreshToken) {
    await markStatus('reauth_required');
    throw new Error('Drive refresh token missing — reauth required');
  }
  try {
    const refreshed = await refreshAccessToken(creds.refreshToken);
    const updated: DriveCreds = {
      ...creds,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    };
    await prisma.integration.update({
      where: { type: DRIVE_TYPE },
      data: {
        creds: updated as unknown as object,
        status: 'ok',
      },
    });
    return refreshed.accessToken;
  } catch (err) {
    logger.warn({ err }, 'drive token refresh failed');
    await markStatus('reauth_required');
    throw err instanceof Error ? err : new Error(String(err));
  }
}
