import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import { env } from '../env.js';

// ---------------------------------------------------------------------------
// Google Drive API wrapper (spec 15)
// Pure I/O: no DB writes. Callers (integration-service / drive-importer) are
// responsible for persisting credentials, mappings and per-file state.
// ---------------------------------------------------------------------------

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
];

function buildOAuth2Client(accessToken?: string) {
  const client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
  if (accessToken) client.setCredentials({ access_token: accessToken });
  return client;
}

export function buildAuthorizeUrl(state: string): string {
  const client = buildOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_SCOPES,
    state,
  });
}

export interface DriveCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  scope: string;
  email: string;
}

export async function exchangeCode(code: string): Promise<DriveCredentials> {
  const client = buildOAuth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('Google did not return an access_token');
  }
  client.setCredentials(tokens);
  const email = await getUserEmail(tokens.access_token);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiresAt: tokens.expiry_date ?? Date.now() + 3600_000,
    scope: tokens.scope ?? DRIVE_SCOPES.join(' '),
    email,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const client = buildOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  if (!credentials.access_token) {
    throw new Error('Google refresh did not return an access_token');
  }
  return {
    accessToken: credentials.access_token,
    expiresAt: credentials.expiry_date ?? Date.now() + 3600_000,
  };
}

export async function getUserEmail(accessToken: string): Promise<string> {
  const auth = buildOAuth2Client(accessToken);
  const oauth2 = google.oauth2({ version: 'v2', auth });
  const res = await oauth2.userinfo.get();
  return res.data.email ?? '';
}

function driveClient(accessToken: string): drive_v3.Drive {
  const auth = buildOAuth2Client(accessToken);
  return google.drive({ version: 'v3', auth });
}

export interface DriveSubfolder {
  id: string;
  name: string;
}

export async function listSubfolders(
  accessToken: string,
  parentFolderId: string,
): Promise<DriveSubfolder[]> {
  const drive = driveClient(accessToken);
  const out: DriveSubfolder[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageToken,
      pageSize: 100,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export interface DriveChangeFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parents: string[];
  trashed: boolean;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveChangeFile;
}

export async function listChanges(
  accessToken: string,
  pageToken: string,
): Promise<{ changes: DriveChange[]; nextPageToken: string }> {
  const drive = driveClient(accessToken);
  const out: DriveChange[] = [];
  let currentPage: string | undefined = pageToken;
  let lastNext: string = pageToken;
  do {
    const res: { data: drive_v3.Schema$ChangeList } = await drive.changes.list({
      pageToken: currentPage,
      pageSize: 100,
      fields:
        'newStartPageToken, nextPageToken, changes(fileId, removed, file(id, name, mimeType, size, parents, trashed))',
      spaces: 'drive',
      includeRemoved: false,
    });
    for (const c of res.data.changes ?? []) {
      if (!c.fileId) continue;
      out.push({
        fileId: c.fileId,
        removed: c.removed ?? false,
        file: c.file
          ? {
              id: c.file.id ?? c.fileId,
              name: c.file.name ?? '',
              mimeType: c.file.mimeType ?? '',
              size: c.file.size ? Number(c.file.size) : 0,
              parents: c.file.parents ?? [],
              trashed: c.file.trashed ?? false,
            }
          : undefined,
      });
    }
    if (res.data.nextPageToken) {
      currentPage = res.data.nextPageToken;
      lastNext = res.data.nextPageToken;
    } else {
      lastNext = res.data.newStartPageToken ?? lastNext;
      currentPage = undefined;
    }
  } while (currentPage);
  return { changes: out, nextPageToken: lastNext };
}

export async function getStartPageToken(accessToken: string): Promise<string> {
  const drive = driveClient(accessToken);
  const res = await drive.changes.getStartPageToken({});
  if (!res.data.startPageToken) {
    throw new Error('Google did not return a startPageToken');
  }
  return res.data.startPageToken;
}

export async function getFileBinary(
  accessToken: string,
  fileId: string,
): Promise<{
  buffer: Buffer;
  mimeType: string;
  name: string;
  size: number;
  parents: string[];
}> {
  const drive = driveClient(accessToken);
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, parents',
  });
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );
  const stream = res.data as unknown as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    buffer: Buffer.concat(chunks),
    mimeType: meta.data.mimeType ?? 'application/octet-stream',
    name: meta.data.name ?? '',
    size: meta.data.size ? Number(meta.data.size) : 0,
    parents: meta.data.parents ?? [],
  };
}

export async function moveFile(
  accessToken: string,
  fileId: string,
  addParents: string,
  removeParents: string,
): Promise<void> {
  const drive = driveClient(accessToken);
  await drive.files.update({
    fileId,
    addParents,
    removeParents,
    fields: 'id, parents',
  });
}

export async function ensureImportedSubfolder(
  accessToken: string,
  parentFolderId: string,
  subfolderName: string,
): Promise<string> {
  const drive = driveClient(accessToken);
  const escapedName = subfolderName.replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  const found = existing.data.files?.[0];
  if (found?.id) return found.id;
  const created = await drive.files.create({
    requestBody: {
      name: subfolderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
  });
  if (!created.data.id) {
    throw new Error('Failed to create imported subfolder');
  }
  return created.data.id;
}

export async function startWatch(
  accessToken: string,
  channelId: string,
  webhookUrl: string,
): Promise<{ resourceId: string; expiration: number } | null> {
  if (!env.GOOGLE_DRIVE_WEBHOOK_BASE_URL) return null;
  const drive = driveClient(accessToken);
  const startPageToken = await getStartPageToken(accessToken);
  const res = await drive.changes.watch({
    pageToken: startPageToken,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
    },
  });
  if (!res.data.resourceId) {
    throw new Error('Google did not return a resourceId for watch channel');
  }
  return {
    resourceId: res.data.resourceId,
    expiration: res.data.expiration ? Number(res.data.expiration) : Date.now() + 7 * 24 * 3600 * 1000,
  };
}

/** フォルダ直下のファイルを列挙する。imagesOnly=true(デフォルト)で画像のみ */
export async function listFilesInFolder(
  accessToken: string,
  folderId: string,
  imagesOnly = true,
): Promise<DriveChangeFile[]> {
  const drive = driveClient(accessToken);
  const out: DriveChangeFile[] = [];
  let pageToken: string | undefined;
  const imageFilter = `and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/gif' or mimeType = 'image/webp')`;
  const q = `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'${imagesOnly ? ' ' + imageFilter : ''}`;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
      pageSize: 100,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (!f.id) continue;
      out.push({
        id: f.id,
        name: f.name ?? '',
        mimeType: f.mimeType ?? '',
        size: f.size ? Number(f.size) : 0,
        parents: f.parents ?? [],
        trashed: false,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function stopWatch(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  const drive = driveClient(accessToken);
  await drive.channels.stop({
    requestBody: { id: channelId, resourceId },
  });
}
