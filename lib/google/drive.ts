import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { DriveFile } from '@/types';
import { log } from '@/lib/db/operations';

// YouTube-compatible video MIME types
const SUPPORTED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-ms-wmv',
  'video/mpeg',
  'video/webm',
  'video/3gpp',
  'video/3gpp2',
  'video/x-flv',
  'video/x-m4v',
  'video/x-matroska',
  'video/ogg',
]);

export function isSupportedVideoMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.has(mimeType);
}

/**
 * Validates that a Google Drive folder is accessible.
 */
export async function validateDriveFolder(
  auth: OAuth2Client,
  folderId: string
): Promise<{ valid: boolean; name?: string; error?: string }> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,mimeType',
    });

    if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
      return { valid: false, error: 'The provided ID is not a folder' };
    }

    return { valid: true, name: res.data.name || folderId };
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    if (error.code === 404) {
      return { valid: false, error: 'Folder not found or not accessible' };
    }
    return { valid: false, error: `Drive error: ${error.message || 'Unknown error'}` };
  }
}

/**
 * Lists all video files in a Google Drive folder.
 * Does NOT recursively traverse subfolders by default.
 */
export async function listVideosInFolder(
  auth: OAuth2Client,
  folderId: string,
  pageToken?: string
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink)',
    pageSize: 100,
    pageToken,
    orderBy: 'createdTime asc',
  });

  const allFiles = (res.data.files || []) as DriveFile[];
  const videoFiles = allFiles.filter((f) => f.mimeType && isSupportedVideoMimeType(f.mimeType));

  await log('INFO', 'DRIVE', `Listed ${allFiles.length} files, ${videoFiles.length} are videos in folder ${folderId}`);

  return {
    files: videoFiles,
    nextPageToken: res.data.nextPageToken || undefined,
  };
}

/**
 * Lists ALL videos in a folder, paginating through all pages.
 */
export async function listAllVideosInFolder(
  auth: OAuth2Client,
  folderId: string
): Promise<DriveFile[]> {
  const allVideos: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const { files, nextPageToken } = await listVideosInFolder(auth, folderId, pageToken);
    allVideos.push(...files);
    pageToken = nextPageToken;
  } while (pageToken);

  return allVideos;
}

/**
 * Gets a readable stream for a Drive file.
 * Used for streaming video data to YouTube upload.
 */
export async function getDriveFileStream(
  auth: OAuth2Client,
  fileId: string
): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; size: number }> {
  const drive = google.drive({ version: 'v3', auth });

  // First get file metadata
  const metaRes = await drive.files.get({
    fileId,
    fields: 'mimeType,size,name',
  });

  const mimeType = metaRes.data.mimeType || 'video/mp4';
  const size = parseInt(metaRes.data.size || '0', 10);

  // Get the file stream
  const streamRes = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return {
    stream: streamRes.data as unknown as NodeJS.ReadableStream,
    mimeType,
    size,
  };
}

/**
 * Download a Drive file to a buffer (for smaller files / AI analysis).
 * Use streaming for actual YouTube uploads.
 */
export async function downloadDriveFile(
  auth: OAuth2Client,
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string; size: number }> {
  const drive = google.drive({ version: 'v3', auth });

  const metaRes = await drive.files.get({
    fileId,
    fields: 'mimeType,size',
  });

  const mimeType = metaRes.data.mimeType || 'video/mp4';
  const size = parseInt(metaRes.data.size || '0', 10);

  const streamRes = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  const buffer = Buffer.from(streamRes.data as ArrayBuffer);

  return { buffer, mimeType, size };
}

/**
 * Checks if a Drive file still exists and is accessible.
 */
export async function checkDriveFileExists(
  auth: OAuth2Client,
  fileId: string
): Promise<boolean> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    await drive.files.get({ fileId, fields: 'id,trashed' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts folder ID from a Google Drive URL or returns the ID directly.
 */
export function parseFolderIdFromUrl(input: string): string {
  // Handle full URLs like:
  // https://drive.google.com/drive/folders/FOLDER_ID
  // https://drive.google.com/drive/u/0/folders/FOLDER_ID
  const folderUrlMatch = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderUrlMatch) return folderUrlMatch[1];

  // Handle direct IDs (alphanumeric with hyphens/underscores)
  if (/^[a-zA-Z0-9_-]+$/.test(input.trim())) {
    return input.trim();
  }

  throw new Error(`Cannot parse folder ID from: ${input}`);
}
