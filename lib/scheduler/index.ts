import { v4 as uuidv4 } from 'uuid';
import {
  getSettings,
  getEligibleVideos,
  atomicReserveVideo,
  updateVideoStatus,
  createUploadJob,
  updateUploadJob,
  recordUploadHistory,
  getTodayUploadCount,
  getActiveYouTubeAccount,
  getActiveDriveSources,
  updateYouTubeTokens,
  saveAIMetadata,
  updateVideoFingerprint,
  findDuplicateByFingerprint,
  log,
} from '@/lib/db/operations';
import { getAuthenticatedClient, decryptToken } from '@/lib/google/auth';
import { getDriveFileStream, downloadDriveFile, checkDriveFileExists } from '@/lib/google/drive';
import { syncAllDriveFolders } from '@/lib/scheduler/sync';
import { repairRecentMetadata } from '@/lib/scheduler/repair';
import { computeFileHash, computeFrameHash } from '@/lib/video/fingerprint';
import { analyzeVideoAndGenerateMetadata } from '@/lib/gemini/analyzer';
import { uploadVideoToYouTube, verifyYouTubeVideo, checkYouTubeQuota } from '@/lib/youtube/upload';
import { sendNotification } from '@/lib/notifications';
import type { SchedulerRunResult, AutomationSettings, Video } from '@/types';

// ============================================================
// MAIN SCHEDULER ENTRY POINT
// ============================================================

// vercel.json caps this route at maxDuration: 300s - reserve enough of that
// for the actual analyze+upload step (observed to take up to ~3 min when the
// AI model is degraded and retries) so a slow Drive sync or repair pass can't
// silently eat the whole budget and leave nothing for the scheduled upload.
const MAX_RUNTIME_MS = 280_000;
const MIN_UPLOAD_BUDGET_MS = 150_000;

export async function runScheduler(triggeredBy: 'cron' | 'manual' = 'cron'): Promise<SchedulerRunResult> {
  const schedulerStartedAt = Date.now();
  const cronRunId = uuidv4();
  const result: SchedulerRunResult = {
    cronRunId,
    videosProcessed: 0,
    videosUploaded: 0,
    videosFailed: 0,
    errors: [],
    dryRun: false,
  };

  await log('INFO', 'CRON', `Scheduler started [${triggeredBy}]`, { cronRunId });

  try {
    // 1. Load settings
    const settings = await getSettings();
    if (!settings) {
      await log('ERROR', 'SCHEDULER', 'No automation settings found');
      result.errors.push('No automation settings found');
      return result;
    }

    result.dryRun = settings.dry_run_mode || process.env.DRY_RUN === 'true';

    // 2. Check if automation is enabled
    if (!settings.is_enabled && triggeredBy === 'cron') {
      await log('INFO', 'SCHEDULER', 'Automation is disabled, skipping cron run');
      return result;
    }

    // 3. Check if we've already met the daily quota
    const todayCount = await getTodayUploadCount(settings.timezone, settings.upload_count_reset_at);
    await log('INFO', 'SCHEDULER', `Today's uploads: ${todayCount}/${settings.daily_upload_limit}`, {
      timezone: settings.timezone,
    });

    if (todayCount >= settings.daily_upload_limit) {
      await log('INFO', 'SCHEDULER', 'Daily upload quota reached, stopping');
      return result;
    }

    const remainingToday = settings.daily_upload_limit - todayCount;

    // 4. Check if current time is within an upload window
    if (triggeredBy === 'cron' && !isInUploadWindow(settings)) {
      await log('INFO', 'SCHEDULER', 'Not within an upload time window, skipping');
      return result;
    }

    // 5. Get YouTube account
    const account = await getActiveYouTubeAccount();
    if (!account) {
      await log('ERROR', 'SCHEDULER', 'No active YouTube account configured');
      await sendNotification('auth_expired', settings);
      result.errors.push('No active YouTube account');
      return result;
    }

    // 6. Get Drive source(s) - a channel can pull videos from more than one folder
    const driveSources = await getActiveDriveSources();
    if (driveSources.length === 0) {
      await log('ERROR', 'SCHEDULER', 'No active Google Drive source configured');
      result.errors.push('No active Drive source');
      return result;
    }

    // 7. Create authenticated clients
    const decryptedRefreshToken = decryptToken(account.refresh_token);
    const auth = await getAuthenticatedClient(
      decryptedRefreshToken,
      account.access_token ? decryptToken(account.access_token) : undefined,
      account.token_expiry || undefined,
      async (newAccessToken, expiry) => {
        await updateYouTubeTokens(account.id, newAccessToken, expiry);
      }
    );

    // 7b. Sync every connected Drive folder so newly added videos are discovered
    // automatically, without requiring someone to click "Sync Drive" by hand. A
    // sync failure here shouldn't abort the run - fall back to whatever's
    // already queued.
    try {
      const syncResult = await syncAllDriveFolders(auth, driveSources);
      if (syncResult.newVideos > 0) {
        await log('INFO', 'SCHEDULER', `Auto-discovered ${syncResult.newVideos} new video(s) from Drive across ${driveSources.length} folder(s)`);
      }
    } catch (err: unknown) {
      const error = err as Error;
      await log('WARN', 'SCHEDULER', `Drive auto-sync failed, continuing with existing queue: ${error.message}`);
    }

    // 8. Check YouTube quota
    const hasQuota = await checkYouTubeQuota(auth);
    if (!hasQuota) {
      await log('ERROR', 'SCHEDULER', 'YouTube API quota exceeded');
      result.errors.push('YouTube API quota exceeded');
      return result;
    }

    // 8b. Repair metadata on recently-uploaded videos that went out weak/unverified
    // (e.g. the AI pipeline was degraded at upload time). Runs regardless of whether
    // there's a new video to upload this cycle - it's fixing history, not uploading -
    // so it must happen before the "no eligible videos" early return below, not after.
    // Skipped if too little time budget remains, so a slow sync or a degraded AI
    // model doesn't consume the whole run and leave nothing for the actual
    // scheduled upload below (this happened in practice: repair alone took several
    // minutes retrying a degraded model and the run got killed by Vercel's timeout
    // before ever reaching the new video).
    const repairDeadline = schedulerStartedAt + MAX_RUNTIME_MS - MIN_UPLOAD_BUDGET_MS;
    const elapsedBeforeRepair = Date.now() - schedulerStartedAt;
    if (Date.now() > repairDeadline) {
      await log('WARN', 'SCHEDULER', `Skipping metadata repair pass to preserve time budget for the scheduled upload (${Math.round(elapsedBeforeRepair / 1000)}s already elapsed)`);
    } else {
      try {
        // Budget-driven, not a fixed count - processes as many weak-metadata
        // videos as safely fit in the time remaining before repairDeadline, so
        // the backlog clears itself across scheduled runs without needing
        // someone to keep clicking "Run Repair" by hand.
        const repairResult = await repairRecentMetadata(auth, settings, { deadline: repairDeadline });
        if (repairResult.attempted > 0) {
          await log('INFO', 'SCHEDULER', `Metadata repair pass: ${repairResult.repaired}/${repairResult.attempted} video(s) updated`);
        }
      } catch (err: unknown) {
        const error = err as Error;
        await log('WARN', 'SCHEDULER', `Metadata repair pass failed, continuing: ${error.message}`);
      }
    }

    // 9. Get eligible videos. A cron run only uploads ONE video per trigger, so that
    // each configured upload_times slot gets its own video instead of one run dumping
    // the whole daily quota at once. A manual run still processes up to the full
    // remaining quota, which is more useful for testing/catch-up.
    const perRunLimit = triggeredBy === 'cron' ? Math.min(1, remainingToday) : remainingToday;
    const eligibleVideos = await getEligibleVideos(
      settings.selection_strategy,
      perRunLimit,
      settings.max_retry_attempts
    );

    await log('INFO', 'DRIVE', `Found ${eligibleVideos.length} eligible videos`);

    if (eligibleVideos.length === 0) {
      await log('INFO', 'SCHEDULER', 'No eligible videos in queue');
      await sendNotification('no_videos', settings);
      return result;
    }

    // 10. Process each eligible video
    for (const video of eligibleVideos) {
      if (result.videosUploaded >= perRunLimit) {
        await log('INFO', 'SCHEDULER', 'Per-run upload limit reached, stopping');
        break;
      }

      await processVideo(video, auth, settings, cronRunId, result);
    }

    // 11. Send success notification if uploads happened
    if (result.videosUploaded > 0 && settings.notify_on_success) {
      await sendNotification('daily_success', settings, {
        uploaded: result.videosUploaded,
        failed: result.videosFailed,
      });
    }

    await log('INFO', 'CRON', `Scheduler completed`, {
      cronRunId,
      uploaded: result.videosUploaded,
      failed: result.videosFailed,
      dryRun: result.dryRun,
    });
  } catch (err: unknown) {
    const error = err as Error;
    await log('ERROR', 'SCHEDULER', `Scheduler crashed: ${error.message}`, { stack: error.stack });
    result.errors.push(error.message);
  }

  return result;
}

// ============================================================
// PROCESS A SINGLE VIDEO
// ============================================================

async function processVideo(
  video: Video,
  auth: import('google-auth-library').OAuth2Client,
  settings: AutomationSettings,
  cronRunId: string,
  result: SchedulerRunResult
): Promise<void> {
  const { id: videoId, drive_file_id: driveFileId, filename } = video;

  await log('INFO', 'SCHEDULER', `Processing video: ${filename}`, { videoId, driveFileId });

  // Create upload job (idempotent)
  const job = await createUploadJob(videoId, cronRunId);

  try {
    // Atomically reserve the video. If it was already PROCESSING (from a crashed/
    // timed-out previous run) and stale enough to reclaim, atomicReserveVideo lets
    // this through anyway - log it so a reclaimed stale lock is visible, not silent.
    if (video.status === 'PROCESSING') {
      await log('WARN', 'SCHEDULER', `Reclaiming stale lock on video ${videoId} (${filename}) - likely an earlier run crashed or timed out mid-processing`);
    }

    const reserved = await atomicReserveVideo(videoId, cronRunId);
    if (!reserved) {
      await log('WARN', 'SCHEDULER', `Video ${videoId} already being processed, skipping`);
      return;
    }

    result.videosProcessed++;

    await updateUploadJob(job.id, { status: 'RUNNING', started_at: new Date().toISOString() });

    // -------- STEP 1: Verify Drive file still exists --------
    await log('INFO', 'DRIVE', `Checking Drive file exists: ${driveFileId}`);
    const fileExists = await checkDriveFileExists(auth, driveFileId);
    if (!fileExists) {
      await log('WARN', 'DRIVE', `Drive file deleted or inaccessible: ${driveFileId}`);
      await updateVideoStatus(videoId, 'SKIPPED', { lastError: 'Drive file no longer accessible' });
      await updateUploadJob(job.id, { status: 'CANCELLED', error_message: 'Drive file not found' });
      return;
    }

    // -------- STEP 2: AI Analysis --------
    await log('INFO', 'AI', `Downloading video for AI analysis: ${filename}`);

    const LARGE_FILE_THRESHOLD = 19 * 1024 * 1024; // 19MB
    let videoBuffer: Buffer;
    let mimeType: string;
    let fileSize: number;

    if ((video.size_bytes || 0) > LARGE_FILE_THRESHOLD * 2) {
      // For very large files, sample just the first portion for AI
      await log('INFO', 'AI', `Large file detected, using stream sample for AI analysis`);
      const { buffer, mimeType: mt, size } = await downloadDriveFile(auth, driveFileId);
      videoBuffer = buffer.slice(0, LARGE_FILE_THRESHOLD);
      mimeType = mt;
      fileSize = size;
    } else {
      const { buffer, mimeType: mt, size } = await downloadDriveFile(auth, driveFileId);
      videoBuffer = buffer;
      mimeType = mt;
      fileSize = size;
    }

    // -------- STEP 2b: Content-based duplicate check --------
    // Runs on the video bytes we already downloaded, before spending an AI call on
    // it - catches same-content-different-filename (or re-encoded) duplicates that
    // the earlier filename-based check in upsertVideoFromDrive can't see.
    const fileHash = computeFileHash(videoBuffer);
    const frameHash = await computeFrameHash(videoBuffer).catch(() => null);
    const duplicate = await findDuplicateByFingerprint(fileHash, frameHash, videoId);

    if (duplicate) {
      await log('WARN', 'SCHEDULER', `Duplicate content detected for ${filename}, matches video ${duplicate.id} (${duplicate.filename})`, {
        videoId,
        duplicateOf: duplicate.id,
      });
      await updateVideoStatus(videoId, 'SKIPPED', { lastError: `Duplicate content of already-processed video: ${duplicate.filename}` });
      await updateUploadJob(job.id, { status: 'CANCELLED', error_message: 'Duplicate content detected' });
      return;
    }

    await updateVideoFingerprint(videoId, fileHash, frameHash);

    // -------- STEP 3: Generate Metadata --------
    await log('INFO', 'AI', `Generating metadata for: ${filename}`);
    const metadata = await analyzeVideoAndGenerateMetadata(videoBuffer, mimeType, filename, {
      nicheDescription: settings.niche_description || undefined,
      defaultHashtags: settings.default_hashtags,
      defaultKeywords: settings.default_keywords,
      categoryId: settings.category_id,
      aiModel: settings.ai_model,
      temperature: settings.ai_creativity,
      maxKeywords: settings.max_keywords,
      maxHashtags: settings.max_hashtags,
      titleStyle: settings.title_style,
    });

    // Save AI metadata to DB
    await saveAIMetadata(videoId, {
      title: metadata.title,
      description: metadata.description,
      hashtags: metadata.hashtags,
      keywords: metadata.keywords,
      category_id: metadata.categoryId,
      pinned_comment: metadata.pinnedComment ?? undefined,
      primary_topic: metadata.primaryTopic,
      secondary_topics: metadata.secondaryTopics,
      emotional_tone: metadata.emotionalTone,
      likely_audience: metadata.likelyAudience,
      confidence: metadata.confidence,
      metadata_score: metadata.metadataScore,
      relevance_score: metadata.relevanceScore,
      searchability_score: metadata.searchabilityScore,
      spam_risk: metadata.spamRisk,
      model_used: settings.ai_model,
      verification_approved: metadata.verification?.approved ?? null,
      verification_score: metadata.verification?.overallScore ?? null,
      verification_issues: metadata.verification?.issues ?? [],
      verification_invalid_keywords: metadata.verification?.invalidKeywords ?? [],
      verification_revised: metadata.verification?.revised ?? false,
    });

    // -------- STEP 4: DRY RUN CHECK --------
    if (result.dryRun) {
      await log('INFO', 'SCHEDULER', `[DRY RUN] Would upload: "${metadata.title}"`, {
        videoId,
        metadata: { title: metadata.title, tags: metadata.hashtags.slice(0, 3) },
      });
      await updateVideoStatus(videoId, 'READY');
      await updateUploadJob(job.id, {
        status: 'COMPLETED',
        completed_at: new Date().toISOString(),
        error_message: 'DRY RUN - not actually uploaded',
      });
      result.videosUploaded++;
      return;
    }

    // -------- STEP 5: Upload to YouTube --------
    await log('INFO', 'UPLOAD', `Starting YouTube upload: "${metadata.title}"`);
    await updateVideoStatus(videoId, 'UPLOADING');

    // For the actual upload, we need the full video stream (not just the sample)
    const { stream: videoStream, size: uploadSize } = await getDriveFileStream(auth, driveFileId);

    const uploadResult = await uploadVideoToYouTube(
      auth,
      videoStream,
      fileSize || uploadSize,
      {
        title: metadata.title,
        description: metadata.description,
        tags: [...metadata.keywords, ...metadata.hashtags],
        categoryId: metadata.categoryId || settings.category_id,
        privacyStatus: settings.privacy_status,
        madeForKids: settings.made_for_kids,
      },
      (bytesUploaded, totalBytes) => {
        // Progress tracking (could emit to DB for real-time UI)
        if (totalBytes > 0) {
          const pct = Math.round((bytesUploaded / totalBytes) * 100);
          if (pct % 25 === 0) {
            console.log(`[UPLOAD] ${filename}: ${pct}%`);
          }
        }
      }
    );

    // -------- STEP 6: Verify Upload (best-effort, never fatal) --------
    // uploadVideoToYouTube() already succeeded above and returned a real video
    // ID - that response IS the authoritative confirmation the upload worked.
    // This check is only for visibility into whether YouTube's read path has
    // caught up yet; it must NEVER throw and send this video back into the
    // retry queue, because that previously produced actual duplicate uploads
    // in production (the insert succeeded, videos.list just lagged behind it,
    // and treating that as a failure caused the same content to be re-uploaded
    // as a second video while the first sat orphaned - not linked in the DB -
    // on the channel).
    await log('INFO', 'YOUTUBE', `Verifying upload: ${uploadResult.videoId}`);
    const verification = await verifyYouTubeVideo(auth, uploadResult.videoId);
    if (!verification.exists) {
      await log('WARN', 'YOUTUBE', `Could not confirm ${uploadResult.videoId} via videos.list yet - proceeding anyway since the upload call itself succeeded`, { videoId });
    }

    // -------- STEP 7: Mark as UPLOADED --------
    await updateVideoStatus(videoId, 'UPLOADED', {
      youtubeVideoId: uploadResult.videoId,
      youtubeUrl: uploadResult.youtubeUrl,
      youtubeTitle: metadata.title,
      lastError: undefined,
    });

    await updateUploadJob(job.id, {
      status: 'COMPLETED',
      completed_at: new Date().toISOString(),
      bytes_uploaded: fileSize || uploadSize,
      total_bytes: fileSize || uploadSize,
    });

    await recordUploadHistory({
      video_id: videoId,
      job_id: job.id,
      youtube_video_id: uploadResult.videoId,
      youtube_url: uploadResult.youtubeUrl,
      title: metadata.title,
      status: 'UPLOADED',
      uploaded_at: new Date().toISOString(),
    });

    await log('INFO', 'DATABASE', `Marked video as uploaded: ${uploadResult.videoId}`, {
      videoId,
      youtubeVideoId: uploadResult.videoId,
      title: metadata.title,
    });

    result.videosUploaded++;
  } catch (err: unknown) {
    const error = err as Error;
    result.videosFailed++;

    await log('ERROR', 'UPLOAD', `Failed to process video ${filename}: ${error.message}`, {
      videoId,
      error: error.message,
    });

    const newAttempts = (video.upload_attempts || 0) + 1;
    const maxRetries = settings.max_retry_attempts;

    if (newAttempts >= maxRetries) {
      await updateVideoStatus(videoId, 'FAILED', {
        lastError: error.message,
        uploadAttempts: newAttempts,
      });
      await log('ERROR', 'SCHEDULER', `Video permanently failed after ${newAttempts} attempts: ${filename}`);
      await sendNotification('upload_failed', settings, { filename, error: error.message });
    } else {
      await updateVideoStatus(videoId, 'DISCOVERED', {
        lastError: error.message,
        uploadAttempts: newAttempts,
      });
      await log('INFO', 'SCHEDULER', `Video will retry (attempt ${newAttempts}/${maxRetries}): ${filename}`);
    }

    await updateUploadJob(job.id, {
      status: 'FAILED',
      failed_at: new Date().toISOString(),
      error_message: error.message,
      attempt_number: (video.upload_attempts || 0) + 1,
    });

    await recordUploadHistory({
      video_id: videoId,
      job_id: job.id,
      title: filename,
      status: 'FAILED',
      uploaded_at: new Date().toISOString(),
    });

    result.errors.push(`${filename}: ${error.message}`);
  }
}

// ============================================================
// TIME WINDOW CHECKING
// ============================================================

/**
 * Checks if the current time is within ±30 minutes of any configured upload time.
 */
function isInUploadWindow(settings: AutomationSettings): boolean {
  const now = new Date();
  const timezone = settings.timezone;

  // Get current time in the configured timezone
  const timeInTZ = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  const [currentHour, currentMinute] = timeInTZ.split(':').map(Number);
  const currentMinutes = currentHour * 60 + currentMinute;

  for (const uploadTime of settings.upload_times) {
    const [targetHour, targetMinute] = uploadTime.split(':').map(Number);
    const targetMinutes = targetHour * 60 + targetMinute;
    const diff = Math.abs(currentMinutes - targetMinutes);

    if (diff <= 35) {
      // Within 35 minutes of the target time
      return true;
    }
  }

  return false;
}

/**
 * Calculate next upload time based on settings and timezone.
 */
// Builds the correct UTC instant for a given "HH:mm" wall-clock time on a given
// calendar date in the target timezone. Timezone-runtime-independent: works the
// same regardless of what timezone the Node process itself is running in, unlike
// a plain `new Date(dateStr + 'THH:mm:00')` which is parsed in the server's local
// timezone (verified with automated tests under TZ=UTC/Asia/Kolkata/America/New_York).
function buildTzDate(dateStr: string, hour: number, minute: number, timeZone: string): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  const guess = new Date(`${dateStr}T${pad(hour)}:${pad(minute)}:00Z`);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(guess).reduce((acc: Record<string, string>, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const shownAsUtc = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}Z`);

  return new Date(guess.getTime() + (guess.getTime() - shownAsUtc.getTime()));
}

export function getNextUploadTime(settings: AutomationSettings): Date | null {
  const timezone = settings.timezone;
  const now = new Date();

  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const candidates: Date[] = [];

  for (const uploadTime of settings.upload_times) {
    const [hour, minute] = uploadTime.split(':').map(Number);
    const candidate = buildTzDate(todayStr, hour, minute, timezone);

    if (candidate > now) {
      candidates.push(candidate);
    }
  }

  if (candidates.length > 0) {
    return candidates.sort((a, b) => a.getTime() - b.getTime())[0];
  }

  // Next day's first slot
  const tomorrow = new Date(`${todayStr}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const firstTime = settings.upload_times[0];
  if (firstTime) {
    const [hour, minute] = firstTime.split(':').map(Number);
    return buildTzDate(tomorrowStr, hour, minute, timezone);
  }

  return null;
}
