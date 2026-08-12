import { NextRequest, NextResponse } from 'next/server';
import {
  getActiveDriveSource,
  getActiveYouTubeAccount,
  upsertDriveSource,
  updateSettings,
  log,
} from '@/lib/db/operations';
import { getAuthenticatedClient, decryptToken } from '@/lib/google/auth';
import { parseFolderIdFromUrl, validateDriveFolder } from '@/lib/google/drive';
import { syncDriveFolder } from '@/lib/scheduler/sync';
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

    const result = await syncDriveFolder(auth, driveSource);

    return NextResponse.json({
      success: true,
      data: {
        ...result,
        folderId,
        folderName: driveSource.folder_name,
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
