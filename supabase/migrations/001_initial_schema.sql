-- ============================================================
-- YouTube Shorts Automation - Initial Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE video_status AS ENUM (
  'DISCOVERED',
  'QUEUED',
  'PROCESSING',
  'READY',
  'UPLOADING',
  'UPLOADED',
  'FAILED',
  'SKIPPED'
);

CREATE TYPE privacy_status AS ENUM ('public', 'unlisted', 'private');

CREATE TYPE selection_strategy AS ENUM ('FIFO', 'RANDOM', 'MANUAL_PRIORITY');

CREATE TYPE job_status AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

-- ============================================================
-- youtube_accounts
-- ============================================================

CREATE TABLE youtube_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id TEXT UNIQUE NOT NULL,
  channel_name TEXT NOT NULL,
  channel_thumbnail TEXT,
  access_token TEXT,                   -- encrypted at app layer
  refresh_token TEXT NOT NULL,         -- encrypted at app layer
  token_expiry TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- drive_sources
-- ============================================================

CREATE TABLE drive_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folder_id TEXT NOT NULL UNIQUE,
  folder_name TEXT,
  folder_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  total_videos_found INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- videos
-- ============================================================

CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  drive_file_id TEXT NOT NULL UNIQUE,    -- permanent dedup key
  drive_source_id UUID REFERENCES drive_sources(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT,
  duration_seconds INTEGER,
  status video_status NOT NULL DEFAULT 'DISCOVERED',
  priority INTEGER NOT NULL DEFAULT 0,   -- higher = uploaded first in MANUAL mode
  youtube_video_id TEXT,
  youtube_url TEXT,
  youtube_title TEXT,
  uploaded_at TIMESTAMPTZ,
  upload_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_videos_drive_file_id ON videos(drive_file_id);
CREATE INDEX idx_videos_scheduled_for ON videos(scheduled_for);
CREATE INDEX idx_videos_uploaded_at ON videos(uploaded_at);
CREATE INDEX idx_videos_drive_source_id ON videos(drive_source_id);

-- ============================================================
-- ai_metadata
-- ============================================================

CREATE TABLE ai_metadata (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  hashtags TEXT[],
  keywords TEXT[],
  category_id TEXT,
  pinned_comment TEXT,
  primary_topic TEXT,
  secondary_topics TEXT[],
  emotional_tone TEXT,
  likely_audience TEXT,
  confidence NUMERIC(4, 3),
  metadata_score INTEGER,              -- 0-100 quality score
  relevance_score INTEGER,
  searchability_score INTEGER,
  spam_risk INTEGER,
  model_used TEXT,
  generation_prompt TEXT,
  raw_response TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_metadata_video_id ON ai_metadata(video_id);

-- ============================================================
-- upload_jobs
-- ============================================================

CREATE TABLE upload_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status job_status NOT NULL DEFAULT 'PENDING',
  scheduled_for TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  resumable_upload_uri TEXT,           -- for resumable YouTube uploads
  bytes_uploaded BIGINT,
  total_bytes BIGINT,
  error_message TEXT,
  error_code TEXT,
  cron_run_id TEXT,                    -- idempotency key per cron run
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_upload_jobs_video_id ON upload_jobs(video_id);
CREATE INDEX idx_upload_jobs_status ON upload_jobs(status);
CREATE INDEX idx_upload_jobs_scheduled_for ON upload_jobs(scheduled_for);
CREATE UNIQUE INDEX idx_upload_jobs_cron_run_video
  ON upload_jobs(cron_run_id, video_id)
  WHERE cron_run_id IS NOT NULL;

-- ============================================================
-- upload_history
-- ============================================================

CREATE TABLE upload_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  job_id UUID REFERENCES upload_jobs(id) ON DELETE SET NULL,
  youtube_video_id TEXT,
  youtube_url TEXT,
  title TEXT,
  status TEXT NOT NULL,
  duration_seconds INTEGER,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_upload_history_uploaded_at ON upload_history(uploaded_at);
CREATE INDEX idx_upload_history_youtube_video_id ON upload_history(youtube_video_id);

-- ============================================================
-- automation_settings
-- ============================================================

CREATE TABLE automation_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  youtube_account_id UUID REFERENCES youtube_accounts(id) ON DELETE SET NULL,
  drive_source_id UUID REFERENCES drive_sources(id) ON DELETE SET NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  daily_upload_limit INTEGER NOT NULL DEFAULT 2,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  upload_times TEXT[] NOT NULL DEFAULT ARRAY['09:00', '19:00'],
  privacy_status privacy_status NOT NULL DEFAULT 'public',
  category_id TEXT NOT NULL DEFAULT '22',
  selection_strategy selection_strategy NOT NULL DEFAULT 'FIFO',
  default_hashtags TEXT[] DEFAULT ARRAY[]::TEXT[],
  default_keywords TEXT[] DEFAULT ARRAY[]::TEXT[],
  niche_description TEXT,
  made_for_kids BOOLEAN NOT NULL DEFAULT false,
  max_retry_attempts INTEGER NOT NULL DEFAULT 3,
  dry_run_mode BOOLEAN NOT NULL DEFAULT false,
  ai_model TEXT NOT NULL DEFAULT 'gemini-1.5-flash',
  ai_creativity NUMERIC(3, 2) NOT NULL DEFAULT 0.7,
  notify_email TEXT,
  notify_on_success BOOLEAN NOT NULL DEFAULT false,
  notify_on_failure BOOLEAN NOT NULL DEFAULT true,
  notify_on_auth_expired BOOLEAN NOT NULL DEFAULT true,
  notify_on_no_videos BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active settings row
CREATE UNIQUE INDEX idx_automation_settings_singleton ON automation_settings((true));

-- Insert default settings
INSERT INTO automation_settings DEFAULT VALUES;

-- ============================================================
-- system_logs
-- ============================================================

CREATE TABLE system_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  level TEXT NOT NULL DEFAULT 'INFO',   -- INFO, WARN, ERROR, DEBUG
  component TEXT NOT NULL,              -- CRON, DRIVE, AI, YOUTUBE, DATABASE, etc.
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  job_id UUID REFERENCES upload_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_system_logs_created_at ON system_logs(created_at DESC);
CREATE INDEX idx_system_logs_level ON system_logs(level);
CREATE INDEX idx_system_logs_component ON system_logs(component);
CREATE INDEX idx_system_logs_video_id ON system_logs(video_id);

-- Auto-purge logs older than 30 days (run via cron or pg_cron if available)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('purge-old-logs', '0 2 * * *',
--   $$DELETE FROM system_logs WHERE created_at < NOW() - INTERVAL '30 days'$$);

-- ============================================================
-- TRIGGERS: updated_at auto-maintenance
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_youtube_accounts_updated_at
  BEFORE UPDATE ON youtube_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_drive_sources_updated_at
  BEFORE UPDATE ON drive_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_videos_updated_at
  BEFORE UPDATE ON videos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_upload_jobs_updated_at
  BEFORE UPDATE ON upload_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_automation_settings_updated_at
  BEFORE UPDATE ON automation_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (service role bypasses all)
-- ============================================================

ALTER TABLE youtube_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by the API)
-- Anonymous/authenticated users have no direct DB access
-- All access goes through server-side API routes
