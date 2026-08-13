import type { OAuth2Client } from 'google-auth-library';
import { listAllVideosInFolder } from '@/lib/google/drive';
import { upsertVideoFromDrive, updateDriveSourceSyncTime, getKnownDriveFileIds, log } from '@/lib/db/operations';
import type { DriveSource } from '@/types';

export interface DriveSyncResult {
  totalFiles: number;
  newVideos: number;
  existingVideos: number;
  duplicatesSkipped: number;
}

/**
 * Discovers video files in the configured Drive folder and upserts them into
 * the videos table. Shared by the manual "Sync Drive" API route and the
 * scheduler, so newly added Drive files get picked up automatically on the
 * next scheduled run instead of requiring someone to click Sync by hand.
 */
export async function syncDriveFolder(auth: OAuth2Client, driveSource: DriveSource): Promise<DriveSyncResult> {
  await log('INFO', 'DRIVE', `Syncing Drive folder: ${driveSource.folder_id}`);
  const files = await listAllVideosInFolder(auth, driveSource.folder_id);
  await log('INFO', 'DRIVE', `Found ${files.length} video files in Drive folder`);

  // One bulk lookup instead of a per-file existence check - the vast majority
  // of files on any given run are already-known, so this turns what used to
  // be hundreds of sequential DB round-trips into one.
  const knownIds = await getKnownDriveFileIds();

  let newCount = 0;
  let existingCount = 0;
  let duplicateCount = 0;

  for (const file of files) {
    if (knownIds.has(file.id)) {
      existingCount++;
      continue;
    }

    const { isNew, isDuplicate } = await upsertVideoFromDrive(
      file.id,
      file.name,
      file.mimeType,
      file.size ? parseInt(file.size, 10) : undefined,
      driveSource.id
    );

    if (isDuplicate) duplicateCount++;
    else if (isNew) newCount++;
    else existingCount++;
  }

  await updateDriveSourceSyncTime(driveSource.id, files.length);

  await log('INFO', 'DRIVE', `Sync complete: ${newCount} new, ${existingCount} existing, ${duplicateCount} duplicates skipped`, {
    folderId: driveSource.folder_id,
    totalFiles: files.length,
  });

  return {
    totalFiles: files.length,
    newVideos: newCount,
    existingVideos: existingCount,
    duplicatesSkipped: duplicateCount,
  };
}
