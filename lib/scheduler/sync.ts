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

export interface MultiDriveSyncResult extends DriveSyncResult {
  perFolder: Array<DriveSyncResult & { folderId: string; folderName?: string }>;
}

async function syncOneFolder(auth: OAuth2Client, driveSource: DriveSource, knownIds: Set<string>): Promise<DriveSyncResult> {
  await log('INFO', 'DRIVE', `Syncing Drive folder: ${driveSource.folder_id}`);
  const files = await listAllVideosInFolder(auth, driveSource.folder_id);
  await log('INFO', 'DRIVE', `Found ${files.length} video files in Drive folder`);

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

    // Mark seen regardless of outcome - if the same file ID also appears in
    // another folder being synced this run, it should be treated as known.
    knownIds.add(file.id);

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

/**
 * Discovers video files in a single configured Drive folder and upserts them
 * into the videos table. Used when a specific folder is just being connected,
 * so the user gets immediate feedback on that one folder.
 */
export async function syncDriveFolder(auth: OAuth2Client, driveSource: DriveSource): Promise<DriveSyncResult> {
  const knownIds = await getKnownDriveFileIds();
  return syncOneFolder(auth, driveSource, knownIds);
}

/**
 * Syncs every connected Drive folder in one pass, sharing a single bulk
 * known-file lookup across all of them. Used by the scheduler and the
 * bare "Sync Drive" action so a channel pulling from multiple folders gets
 * all of them discovered automatically, not just whichever was connected
 * most recently.
 */
export async function syncAllDriveFolders(auth: OAuth2Client, sources: DriveSource[]): Promise<MultiDriveSyncResult> {
  const knownIds = await getKnownDriveFileIds();
  const perFolder: MultiDriveSyncResult['perFolder'] = [];
  const totals = { totalFiles: 0, newVideos: 0, existingVideos: 0, duplicatesSkipped: 0 };

  for (const source of sources) {
    const result = await syncOneFolder(auth, source, knownIds);
    perFolder.push({ folderId: source.folder_id, folderName: source.folder_name ?? undefined, ...result });
    totals.totalFiles += result.totalFiles;
    totals.newVideos += result.newVideos;
    totals.existingVideos += result.existingVideos;
    totals.duplicatesSkipped += result.duplicatesSkipped;
  }

  return { ...totals, perFolder };
}
