import { NextRequest, NextResponse } from 'next/server';
import {
  getActiveDriveSources,
  getActiveYouTubeAccount,
  upsertDriveSource,
  deactivateDriveSource,
  log,
} from '@/lib/db/operations';
import { getAuthenticatedClient, decryptToken } from '@/lib/google/auth';
import { parseFolderIdFromUrl, validateDriveFolder } from '@/lib/google/drive';
import { syncDriveFolder, syncAllDriveFolders } from '@/lib/scheduler/sync';
import { z } from 'zod';

const SyncBodySchema = z.object({
  folderId: z.string().optional(),
  folderUrl: z.string().optional(),
});

/**
 * POST /api/drive/sync
 * With folderId/folderUrl: connects a NEW Drive folder (in addition to any
 * already connected - a channel can pull videos from more than one folder)
 * and syncs just that one for immediate feedback.
 * Without either: syncs every currently-connected folder.
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

    if (parsed.data.folderId || parsed.data.folderUrl) {
      const input = parsed.data.folderId || parsed.data.folderUrl || '';
      const folderId = parseFolderIdFromUrl(input);

      const { valid, name, error } = await validateDriveFolder(auth, folderId);
      if (!valid) {
        return NextResponse.json(
          { success: false, error: error || 'Folder not accessible' },
          { status: 400 }
        );
      }

      // Adds this folder alongside any already connected - upsertDriveSource
      // keys on the folder's own unique ID, so this never overwrites a
      // different folder that's already connected.
      const driveSource = await upsertDriveSource(
        folderId,
        name,
        `https://drive.google.com/drive/folders/${folderId}`
      );

      await log('INFO', 'DRIVE', `Drive folder configured: ${name} (${folderId})`);

      const result = await syncDriveFolder(auth, driveSource);

      return NextResponse.json({
        success: true,
        data: { ...result, folderId, folderName: driveSource.folder_name },
      });
    }

    // No folder given - sync everything currently connected.
    const driveSources = await getActiveDriveSources();
    if (driveSources.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No Drive folder configured. Provide folderId or folderUrl.' },
        { status: 400 }
      );
    }

    const result = await syncAllDriveFolders(auth, driveSources);
    return NextResponse.json({ success: true, data: result });
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
 * Returns every currently-connected Drive folder.
 */
export async function GET() {
  try {
    const driveSources = await getActiveDriveSources();
    return NextResponse.json({ success: true, data: driveSources });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const DeleteBodySchema = z.object({
  id: z.string().uuid(),
});

/**
 * DELETE /api/drive/sync
 * Disconnects a Drive folder (soft-deactivate, not a hard delete - videos
 * already discovered from it keep their drive_source_id reference intact).
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = DeleteBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Missing or invalid folder id' }, { status: 400 });
    }

    await deactivateDriveSource(parsed.data.id);
    await log('INFO', 'DRIVE', `Drive folder disconnected: ${parsed.data.id}`);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
