// ============================================================
// Core Types - YouTube Shorts Automation System
// ============================================================

export type VideoStatus =
  | 'DISCOVERED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'READY'
  | 'UPLOADING'
  | 'UPLOADED'
  | 'FAILED'
  | 'SKIPPED';

export type PrivacyStatus = 'public' | 'unlisted' | 'private';
export type SelectionStrategy = 'FIFO' | 'RANDOM' | 'MANUAL_PRIORITY';
export type TitleStyle = 'curiosity_with_accuracy' | 'direct_and_clear' | 'bold_statement' | 'question_based';
export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
export type LogComponent =
  | 'CRON'
  | 'DRIVE'
  | 'AI'
  | 'YOUTUBE'
  | 'DATABASE'
  | 'SCHEDULER'
  | 'AUTH'
  | 'UPLOAD'
  | 'NOTIFICATION'
  | 'HEALTH';

// ============================================================
// Database Row Types
// ============================================================

export interface YouTubeAccount {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_thumbnail?: string;
  access_token?: string;
  refresh_token: string;
  token_expiry?: string;
  is_active: boolean;
  authorized_at: string;
  revoked_at?: string;
  created_at: string;
  updated_at: string;
}

export interface DriveSource {
  id: string;
  folder_id: string;
  folder_name?: string;
  folder_url?: string;
  is_active: boolean;
  last_synced_at?: string;
  total_videos_found: number;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: string;
  drive_file_id: string;
  drive_source_id?: string;
  filename: string;
  mime_type: string;
  size_bytes?: number;
  duration_seconds?: number;
  status: VideoStatus;
  priority: number;
  youtube_video_id?: string;
  youtube_url?: string;
  youtube_title?: string;
  uploaded_at?: string;
  upload_attempts: number;
  last_error?: string;
  last_error_at?: string;
  scheduled_for?: string;
  discovered_at: string;
  created_at: string;
  updated_at: string;
}

export interface AIMetadata {
  id: string;
  video_id: string;
  title?: string;
  description?: string;
  hashtags?: string[];
  keywords?: string[];
  category_id?: string;
  pinned_comment?: string;
  primary_topic?: string;
  secondary_topics?: string[];
  emotional_tone?: string;
  likely_audience?: string;
  confidence?: number;
  metadata_score?: number;
  relevance_score?: number;
  searchability_score?: number;
  spam_risk?: number;
  model_used?: string;
  verification_approved?: boolean | null;
  verification_score?: number | null;
  verification_issues?: string[];
  verification_invalid_keywords?: { keyword: string; reason: string }[];
  verification_revised?: boolean;
  generated_at: string;
  created_at: string;
}

export interface UploadJob {
  id: string;
  video_id: string;
  status: JobStatus;
  scheduled_for?: string;
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  attempt_number: number;
  resumable_upload_uri?: string;
  bytes_uploaded?: number;
  total_bytes?: number;
  error_message?: string;
  error_code?: string;
  cron_run_id?: string;
  created_at: string;
  updated_at: string;
}

export interface UploadHistory {
  id: string;
  video_id?: string;
  job_id?: string;
  youtube_video_id?: string;
  youtube_url?: string;
  title?: string;
  status: string;
  duration_seconds?: number;
  uploaded_at: string;
  created_at: string;
}

export interface AutomationSettings {
  id: string;
  youtube_account_id?: string;
  drive_source_id?: string;
  is_enabled: boolean;
  daily_upload_limit: number;
  timezone: string;
  upload_times: string[];
  privacy_status: PrivacyStatus;
  category_id: string;
  selection_strategy: SelectionStrategy;
  default_hashtags: string[];
  default_keywords: string[];
  niche_description?: string;
  made_for_kids: boolean;
  max_retry_attempts: number;
  dry_run_mode: boolean;
  ai_model: string;
  ai_creativity: number;
  upload_count_reset_at?: string | null;
  max_keywords: number;
  max_hashtags: number;
  title_style: TitleStyle;
  notify_email?: string;
  notify_on_success: boolean;
  notify_on_failure: boolean;
  notify_on_auth_expired: boolean;
  notify_on_no_videos: boolean;
  created_at: string;
  updated_at: string;
}

export interface SystemLog {
  id: string;
  level: LogLevel;
  component: LogComponent;
  message: string;
  metadata?: Record<string, unknown>;
  video_id?: string;
  job_id?: string;
  created_at: string;
}

// ============================================================
// AI Metadata Generation
// ============================================================

export interface GeneratedMetadata {
  title: string;
  description: string;
  hashtags: string[];
  keywords: string[];
  categoryId: string;
  pinnedComment?: string;
  primaryTopic: string;
  secondaryTopics: string[];
  emotionalTone: string;
  likelyAudience: string;
  confidence: number;
  metadataScore: number;
  relevanceScore: number;
  searchabilityScore: number;
  spamRisk: number;
  // Populated by the independent verification pass, when one actually ran (there's
  // nothing to verify against for pure filename-fallback metadata). Not sent to
  // YouTube - only used for persisting/displaying verification results.
  verification?: {
    approved: boolean;
    overallScore: number;
    issues: string[];
    invalidKeywords: { keyword: string; reason: string }[];
    revised: boolean;
  };
}

// ============================================================
// API Response Types
// ============================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface DashboardStats {
  todayUploaded: number;
  todayLimit: number;
  todayRemaining: number;
  todayFailed: number;
  queueCount: number;
  totalUploaded: number;
  totalFailed: number;
  nextUploadTime?: string;
  lastUploadAt?: string;
  lastUploadTitle?: string;
  automationActive: boolean;
  driveConnected: boolean;
  youtubeConnected: boolean;
  channelName?: string;
  driveFolderName?: string;
}

export interface QueueItem extends Video {
  ai_metadata?: AIMetadata;
  upload_job?: UploadJob;
}

// ============================================================
// Drive Types
// ============================================================

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

// ============================================================
// YouTube Types
// ============================================================

export interface YouTubeUploadParams {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: PrivacyStatus;
  madeForKids: boolean;
}

export interface YouTubeUploadResult {
  videoId: string;
  youtubeUrl: string;
  title: string;
  status: string;
}

// ============================================================
// Scheduler Types
// ============================================================

export interface SchedulerRunResult {
  cronRunId: string;
  videosProcessed: number;
  videosUploaded: number;
  videosFailed: number;
  errors: string[];
  dryRun: boolean;
}

export interface UploadSlot {
  time: string;         // "09:00"
  scheduledAt: Date;
  isPast: boolean;
  isNext: boolean;
}
