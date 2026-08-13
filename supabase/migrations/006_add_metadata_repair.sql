-- ============================================================
-- Automated metadata repair: detects already-uploaded videos that
-- went out with weak/unverified fallback metadata (e.g. the AI
-- pipeline failed at the time and fell back to a filename-based
-- title) and re-generates + re-verifies + re-publishes their
-- YouTube title/description/tags, scoped to recent uploads.
-- ============================================================

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS metadata_repaired_at TIMESTAMPTZ;

ALTER TABLE automation_settings
  ADD COLUMN IF NOT EXISTS auto_repair_metadata BOOLEAN NOT NULL DEFAULT true;
