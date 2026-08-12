import { NextRequest, NextResponse } from 'next/server';
import {
  getActiveDriveSource,
  getActiveYouTubeAccount,
  upsertVideoFromDrive,
  updateDriveSourceSyncTime,
  upsertDriveSource,
  updateSettings,
  log,
} from '@/lib/db/operations';
import { getAuthenticatedClient, decryptToken } from '@/lib/google/auth';
import { parseFolderIdFromUrl } from '@/lib/google/drive';
import { listAllVideosInFolder, validateDriveFolder } from '@/lib/google/drive';
import { z } from 'zod';

const SyncBodySchema = z.object({
  folderId: z.string().optional(),
  folderUrl: z.string().optional(),
});

/**
 * POST /api/drive/sync
 * Syncs the Google Drive folder, discovering new videos.
 * Can also configure a new folder when folderId/folderUrl is provided.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = SyncBodySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid request body' },
        { status: 400 }
      );
    }

    // Get YouTube account for Google auth (shares OAuth credentials)
    const account = await getActiveYouTubeAccount();
    if (!account) {
      return NextResponse.json(
        { success: false, error: 'No YouTube account authorized. Please connect Google first.' },
        { status: 400 }
      );
    }

    const auth = await getAuthenticatedClient(
      decryptToken(account.refresh_token),
      account.access_token ? decryptToken(account.access_token) : undefined,
      account.token_expiry || undefined
    );

    // Determine folder to sync
    let folderId: string;
    let driveSource = await getActiveDriveSource();

    if (parsed.data.folderId || parsed.data.folderUrl) {
      const input = parsed.data.folderId || parsed.data.folderUrl || '';
      folderId = parseFolderIdFromUrl(input);

      // Validate the folder
      const { valid, name, error } = await validateDriveFolder(auth, folderId);
      if (!valid) {
        return NextResponse.json(
          { success: false, error: error || 'Folder not accessible' },
          { status: 400 }
        );
      }

      // Save/update drive source
      driveSource = await upsertDriveSource(
        folderId,
        name,
        `https://drive.google.com/drive/folders/${folderId}`
      );
      await updateSettings({ drive_source_id: driveSource.id });

      await log('INFO', 'DRIVE', `Drive folder configured: ${name} (${folderId})`);
    } else if (driveSource) {
      folderId = driveSource.folder_id;
    } else {
      return NextResponse.json(
        { success: false, error: 'No Drive folder configured. Provide folderId or folderUrl.' },
        { status: 400 }
      );
    }

    // List all videos in the folder
    await log('INFO', 'DRIVE', `Syncing Drive folder: ${folderId}`);
    const files = await listAllVideosInFolder(auth, folderId);

    await log('INFO', 'DRIVE', `Found ${files.length} video files in Drive folder`);

    // Upsert each file into the database
    let newCount = 0;
    let existingCount = 0;
    let duplicateCount = 0;

    for (const file of files) {
      const { isNew, isDuplicate } = await upsertVideoFromDrive(
        file.id,
        file.name,
        file.mimeType,
        file.size ? parseInt(file.size, 10) : undefined,
        driveSource?.id
      );

      if (isDuplicate) duplicateCount++;
      else if (isNew) newCount++;
      else existingCount++;
    }

    // Update sync metadata
    if (driveSource) {
      await updateDriveSourceSyncTime(driveSource.id, files.length);
    }

    await log('INFO', 'DRIVE', `Sync complete: ${newCount} new, ${existingCount} existing, ${duplicateCount} duplicates skipped`, {
      folderId,
      totalFiles: files.length,
    });

    return NextResponse.json({
      success: true,
      data: {
        totalFiles: files.length,
        newVideos: newCount,
        existingVideos: existingCount,
        duplicatesSkipped: duplicateCount,
        folderId,
        folderName: driveSource?.folder_name,
      },
    });
  } catch (err: unknown) {
    const error = err as Error;
    await log('ERROR', 'DRIVE', `Drive sync failed: ${error.message}`, { stack: error.stack });
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/drive/sync
 * Returns current Drive source info.
 */
export async function GET() {
  try {
    const driveSource = await getActiveDriveSource();
    return NextResponse.json({ success: true, data: driveSource });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
