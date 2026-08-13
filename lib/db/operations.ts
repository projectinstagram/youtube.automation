import { supabase } from './client';
export { supabase } from './client';
import type {
  Video,
  VideoStatus,
  AutomationSettings,
  UploadJob,
  SystemLog,
  LogLevel,
  LogComponent,
  AIMetadata,
  UploadHistory,
  YouTubeAccount,
  DriveSource,
  DashboardStats,
} from '@/types';

// ============================================================
// LOGGING
// ============================================================

export async function log(
  level: LogLevel,
  component: LogComponent,
  message: string,
  metadata?: Record<string, unknown>,
  videoId?: string,
  jobId?: string
): Promise<void> {
  console.log(`[${component}] ${level}: ${message}`, metadata || '');

  try {
    await supabase.from('system_logs').insert({
      level,
      component,
      message,
      metadata: metadata || {},
      video_id: videoId || null,
      job_id: jobId || null,
    });
  } catch (err) {
    console.error('Failed to write log to database:', err);
  }
}

// ============================================================
// SETTINGS
// ============================================================

export async function getSettings(): Promise<AutomationSettings | null> {
  const { data, error } = await supabase
    .from('automation_settings')
    .select('*')
    .single();
  if (error) { console.error('Failed to load settings:', error); return null; }
  return data as AutomationSettings;
}

export async function updateSettings(updates: Partial<AutomationSettings>): Promise<AutomationSettings> {
  const { data, error } = await supabase
    .from('automation_settings')
    .update(updates)
    .not('id', 'is', null)
    .select()
    .single();
  if (error) throw new Error(`Failed to update settings: ${error.message}`);
  return data as AutomationSettings;
}

// ============================================================
// YOUTUBE ACCOUNTS
// ============================================================

export async function upsertYouTubeAccount(account: Omit<YouTubeAccount, 'id' | 'created_at' | 'updated_at'>): Promise<YouTubeAccount> {
  const { data, error } = await supabase
    .from('youtube_accounts')
    .upsert(account, { onConflict: 'channel_id' })
    .select()
    .single();
  if (error) throw new Error(`Failed to upsert YouTube account: ${error.message}`);
  return data as YouTubeAccount;
}

export async function getActiveYouTubeAccount(): Promise<YouTubeAccount | null> {
  const { data, error } = await supabase
    .from('youtube_accounts')
    .select('*')
    .eq('is_active', true)
    .is('revoked_at', null)
    .order('authorized_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get YouTube account: ${error.message}`);
  return data as YouTubeAccount | null;
}

export async function updateYouTubeTokens(accountId: string, accessToken: string, tokenExpiry: Date): Promise<void> {
  const { error } = await supabase
    .from('youtube_accounts')
    .update({ access_token: accessToken, token_expiry: tokenExpiry.toISOString() })
    .eq('id', accountId);
  if (error) throw new Error(`Failed to update tokens: ${error.message}`);
}

// ============================================================
// DRIVE SOURCES
// ============================================================

export async function upsertDriveSource(folderId: string, folderName?: string, folderUrl?: string): Promise<DriveSource> {
  const { data, error } = await supabase
    .from('drive_sources')
    .upsert({ folder_id: folderId, folder_name: folderName, folder_url: folderUrl, is_active: true }, { onConflict: 'folder_id' })
    .select()
    .single();
  if (error) throw new Error(`Failed to upsert drive source: ${error.message}`);
  return data as DriveSource;
}

export async function getActiveDriveSource(): Promise<DriveSource | null> {
  const { data, error } = await supabase
    .from('drive_sources')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get drive source: ${error.message}`);
  return data as DriveSource | null;
}

export async function updateDriveSourceSyncTime(sourceId: string, count: number): Promise<void> {
  const { error } = await supabase
    .from('drive_sources')
    .update({ last_synced_at: new Date().toISOString(), total_videos_found: count })
    .eq('id', sourceId);
  if (error) throw new Error(`Failed to update drive source sync time: ${error.message}`);
}

// ============================================================
// VIDEOS
// ============================================================

export async function upsertVideoFromDrive(driveFileId: string, filename: string, mimeType: string, sizeBytes?: number, driveSourceId?: string): Promise<{ video: Video; isNew: boolean; isDuplicate: boolean }> {
  const { data: existing } = await supabase.from('videos').select('*').eq('drive_file_id', driveFileId).maybeSingle();
  if (existing) return { video: existing as Video, isNew: false, isDuplicate: false };

  // Duplicate detection: same filename already uploaded (or in-flight) under a different Drive file id
  // (e.g. the same video re-added to the Drive folder after already being processed)
  const { data: duplicates } = await supabase
    .from('videos')
    .select('id')
    .neq('drive_file_id', driveFileId)
    .in('status', ['UPLOADED', 'UPLOADING', 'PROCESSING', 'READY', 'QUEUED'])
    .ilike('filename', filename.trim());
  const isDuplicate = (duplicates?.length || 0) > 0;

  const { data, error } = await supabase
    .from('videos')
    .insert({
      drive_file_id: driveFileId,
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes || null,
      drive_source_id: driveSourceId || null,
      status: isDuplicate ? 'SKIPPED' : 'DISCOVERED',
      last_error: isDuplicate ? 'Skipped: duplicate of an already-uploaded/queued video with the same filename' : null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: raceData } = await supabase.from('videos').select('*').eq('drive_file_id', driveFileId).single();
      return { video: raceData as Video, isNew: false, isDuplicate: false };
    }
    throw new Error(`Failed to insert video: ${error.message}`);
  }
  return { video: data as Video, isNew: true, isDuplicate };
}

// If a cron run crashes/times out mid-processing, a video is left stuck in
// PROCESSING forever with no code path to release it - there was no timeout-based
// recovery. After this many minutes without an update, treat a PROCESSING video
// as abandoned and make it eligible again, same as a fresh video.
const STALE_LOCK_MINUTES = 15;

export async function getEligibleVideos(strategy: string, limit: number, maxRetries: number): Promise<Video[]> {
  const staleThreshold = new Date(Date.now() - STALE_LOCK_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .or(`status.in.(DISCOVERED,QUEUED,READY),and(status.eq.FAILED,upload_attempts.lt.${maxRetries}),and(status.eq.PROCESSING,updated_at.lt.${staleThreshold})`)
    .order(strategy === 'MANUAL_PRIORITY' ? 'priority' : 'discovered_at', { ascending: strategy !== 'MANUAL_PRIORITY' })
    .limit(limit);

  if (error) throw new Error(`Failed to get eligible videos: ${error.message}`);
  const videos = (data as Video[]) || [];
  return strategy === 'RANDOM' ? videos.sort(() => Math.random() - 0.5) : videos;
}

export async function atomicReserveVideo(videoId: string, _cronRunId: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - STALE_LOCK_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('videos')
    .update({ status: 'PROCESSING', updated_at: new Date().toISOString() })
    .eq('id', videoId)
    .or(`status.in.(DISCOVERED,QUEUED,READY,FAILED),and(status.eq.PROCESSING,updated_at.lt.${staleThreshold})`)
    .select('id');
  if (error) { console.error('Atomic reserve error:', error); return false; }
  return Array.isArray(data) && data.length > 0;
}

export async function updateVideoStatus(videoId: string, status: VideoStatus, extra?: { youtubeVideoId?: string; youtubeUrl?: string; youtubeTitle?: string; lastError?: string; uploadAttempts?: number; }): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (status === 'UPLOADED') updates.uploaded_at = new Date().toISOString();
  if (status === 'FAILED') updates.last_error_at = new Date().toISOString();
  if (extra?.youtubeVideoId) updates.youtube_video_id = extra.youtubeVideoId;
  if (extra?.youtubeUrl) updates.youtube_url = extra.youtubeUrl;
  if (extra?.youtubeTitle) updates.youtube_title = extra.youtubeTitle;
  if (extra?.lastError !== undefined) updates.last_error = extra.lastError;
  if (extra?.uploadAttempts !== undefined) updates.upload_attempts = extra.uploadAttempts;
  const { error } = await supabase.from('videos').update(updates).eq('id', videoId);
  if (error) throw new Error(`Failed to update video status: ${error.message}`);
}

export async function getVideosByStatus(status: VideoStatus | VideoStatus[]): Promise<Video[]> {
  const statuses = Array.isArray(status) ? status : [status];
  const { data, error } = await supabase.from('videos').select('*').in('status', statuses).order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to get videos: ${error.message}`);
  return (data as Video[]) || [];
}

export async function getAllVideos(limit = 100, offset = 0): Promise<Video[]> {
  const { data, error } = await supabase.from('videos').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw new Error(`Failed to get all videos: ${error.message}`);
  return (data as Video[]) || [];
}

export async function getVideoById(videoId: string): Promise<Video | null> {
  const { data, error } = await supabase.from('videos').select('*').eq('id', videoId).maybeSingle();
  if (error) throw new Error(`Failed to get video: ${error.message}`);
  return data as Video | null;
}

export async function updateVideoFingerprint(videoId: string, fileHash: string, frameHash: string | null): Promise<void> {
  const { error } = await supabase.from('videos').update({ file_hash: fileHash, frame_hash: frameHash }).eq('id', videoId);
  if (error) console.error('Failed to save video fingerprint:', error);
}

/**
 * Checks the new video's content fingerprint against already-uploaded/in-flight
 * videos: an exact file_hash match (byte-identical re-upload), or a frame_hash
 * within a small Hamming distance (re-encoded copy of the same footage - see
 * lib/video/fingerprint.ts for how the threshold was calibrated). Limited to a
 * reasonably recent window so this stays cheap as the channel's history grows.
 */
export async function findDuplicateByFingerprint(
  fileHash: string,
  frameHash: string | null,
  excludeVideoId: string
): Promise<Video | null> {
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .neq('id', excludeVideoId)
    .in('status', ['UPLOADED', 'UPLOADING', 'PROCESSING', 'READY'])
    .not('file_hash', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Failed to query for duplicate fingerprints:', error);
    return null; // Fail open - a lookup error shouldn't block the pipeline
  }

  const candidates = (data as Video[]) || [];

  const exactMatch = candidates.find((v) => v.file_hash === fileHash);
  if (exactMatch) return exactMatch;

  if (frameHash) {
    // Hamming distance inline (avoids importing the fingerprint module's ffmpeg
    // dependency into this file just for the bit-counting helper)
    const HAMMING_DUPLICATE_THRESHOLD = 8;
    for (const candidate of candidates) {
      if (!candidate.frame_hash || candidate.frame_hash.length !== frameHash.length) continue;
      let distance = 0;
      for (let i = 0; i < frameHash.length; i++) {
        const xor = parseInt(frameHash[i], 16) ^ parseInt(candidate.frame_hash[i], 16);
        distance += xor.toString(2).split('1').length - 1;
      }
      if (distance <= HAMMING_DUPLICATE_THRESHOLD) return candidate;
    }
  }

  return null;
}

// ============================================================
// AI METADATA
// ============================================================

export async function saveAIMetadata(videoId: string, metadata: Omit<AIMetadata, 'id' | 'video_id' | 'generated_at' | 'created_at'>): Promise<AIMetadata> {
  await supabase.from('ai_metadata').delete().eq('video_id', videoId);
  const { data, error } = await supabase.from('ai_metadata').insert({ ...metadata, video_id: videoId }).select().single();
  if (error) throw new Error(`Failed to save AI metadata: ${error.message}`);
  return data as AIMetadata;
}

export async function getAIMetadata(videoId: string): Promise<AIMetadata | null> {
  const { data, error } = await supabase.from('ai_metadata').select('*').eq('video_id', videoId).maybeSingle();
  if (error) throw new Error(`Failed to get AI metadata: ${error.message}`);
  return data as AIMetadata | null;
}

// ============================================================
// UPLOAD JOBS
// ============================================================

export async function createUploadJob(videoId: string, cronRunId: string, scheduledFor?: Date): Promise<UploadJob> {
  const { data, error } = await supabase
    .from('upload_jobs')
    .insert({ video_id: videoId, status: 'PENDING', cron_run_id: cronRunId, scheduled_for: scheduledFor?.toISOString() || null })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supabase.from('upload_jobs').select('*').eq('cron_run_id', cronRunId).eq('video_id', videoId).single();
      return existing as UploadJob;
    }
    throw new Error(`Failed to create upload job: ${error.message}`);
  }
  return data as UploadJob;
}

export async function updateUploadJob(jobId: string, updates: Partial<UploadJob>): Promise<void> {
  const { error } = await supabase.from('upload_jobs').update(updates).eq('id', jobId);
  if (error) throw new Error(`Failed to update upload job: ${error.message}`);
}

// ============================================================
// UPLOAD HISTORY
// ============================================================

export async function recordUploadHistory(entry: Omit<UploadHistory, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supabase.from('upload_history').insert(entry);
  if (error) console.error('Failed to record upload history:', error);
}

// ============================================================
// DASHBOARD STATS
// ============================================================

export async function getDashboardStats(timezone: string, dailyLimit: number, resetAt?: string | null): Promise<DashboardStats> {
  const todayStart = getTodayStart(timezone);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);
  const countFrom = resetAt && new Date(resetAt) > todayStart ? new Date(resetAt) : todayStart;

  const [todayHistoryResult, queueCountResult, totalUploadedResult, totalFailedResult, lastUploadResult] = await Promise.all([
    supabase.from('upload_history').select('id, status, title, uploaded_at').gte('uploaded_at', countFrom.toISOString()).lt('uploaded_at', todayEnd.toISOString()),
    supabase.from('videos').select('id', { count: 'exact', head: true }).in('status', ['DISCOVERED', 'QUEUED', 'READY']),
    supabase.from('videos').select('id', { count: 'exact', head: true }).eq('status', 'UPLOADED'),
    supabase.from('videos').select('id', { count: 'exact', head: true }).eq('status', 'FAILED'),
    supabase.from('upload_history').select('title, uploaded_at, youtube_video_id').eq('status', 'UPLOADED').order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const todayHistory = todayHistoryResult.data || [];
  const todayUploaded = todayHistory.filter((h) => h.status === 'UPLOADED').length;
  const todayFailed = todayHistory.filter((h) => h.status === 'FAILED').length;

  const account = await getActiveYouTubeAccount();
  const driveSource = await getActiveDriveSource();
  const settings = await getSettings();

  return {
    todayUploaded,
    todayLimit: dailyLimit,
    todayRemaining: Math.max(0, dailyLimit - todayUploaded),
    todayFailed,
    queueCount: queueCountResult.count || 0,
    totalUploaded: totalUploadedResult.count || 0,
    totalFailed: totalFailedResult.count || 0,
    lastUploadAt: lastUploadResult.data?.uploaded_at,
    lastUploadTitle: lastUploadResult.data?.title,
    automationActive: settings?.is_enabled || false,
    driveConnected: !!driveSource,
    youtubeConnected: !!account,
    channelName: account?.channel_name,
    driveFolderName: driveSource?.folder_name,
  };
}

function getTodayStart(timezone: string): Date {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return new Date(`${year}-${month}-${day}T00:00:00`);
}

// ============================================================
// LOGS
// ============================================================

export async function getLogs(limit = 100, component?: string, level?: string): Promise<SystemLog[]> {
  let query = supabase.from('system_logs').select('*').order('created_at', { ascending: false }).limit(limit);
  if (component) query = query.eq('component', component);
  if (level) query = query.eq('level', level);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to get logs: ${error.message}`);
  return (data as SystemLog[]) || [];
}

/**
 * Counts recent consecutive-ish AI failure logs for a specific model, used to drive
 * a circuit breaker. Reuses the existing system_logs table (no new schema) - each
 * serverless invocation is a fresh process, so an in-memory circuit breaker would
 * reset every cron run and never actually trip; this makes the breaker state
 * persist across invocations by deriving it from recent log history instead.
 *
 * Deliberately counts WARN as well as ERROR: a per-attempt failure against a
 * struggling model is logged at WARN until the final attempt, so filtering to
 * ERROR-only meant a model that fails fast (attempt 1) but always recovers via
 * fallback would never accumulate enough ERROR rows to trip the breaker at all.
 */
export async function getRecentModelFailureCount(model: string, windowMinutes: number): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('system_logs')
    .select('id', { count: 'exact', head: true })
    .eq('component', 'AI')
    .in('level', ['WARN', 'ERROR'])
    .eq('metadata->>model', model)
    .gte('created_at', since);

  if (error) {
    console.error('Failed to query recent model failures:', error);
    return 0; // Fail open - a logging query error shouldn't block the pipeline
  }
  return count || 0;
}

// ============================================================
// DAILY UPLOAD COUNT
// ============================================================

export async function getTodayUploadCount(timezone: string, resetAt?: string | null): Promise<number> {
  const todayStart = getTodayStart(timezone);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);
  const countFrom = resetAt && new Date(resetAt) > todayStart ? new Date(resetAt) : todayStart;
  const { count, error } = await supabase
    .from('upload_history')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'UPLOADED')
    .gte('uploaded_at', countFrom.toISOString())
    .lt('uploaded_at', todayEnd.toISOString());
  if (error) throw new Error(`Failed to count today's uploads: ${error.message}`);
  return count || 0;
}

/**
 * Resets today's upload count back to zero without touching real upload_history
 * records, by marking "now" as the point after which uploads count toward today's quota.
 */
export async function resetDailyUploadCount(): Promise<AutomationSettings> {
  return updateSettings({ upload_count_reset_at: new Date().toISOString() });
}
