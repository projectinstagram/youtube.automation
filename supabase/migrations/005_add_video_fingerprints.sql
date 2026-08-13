-- ============================================================
-- Content-based duplicate detection: SHA-256 of the video bytes
-- (exact re-uploads) and a perceptual difference-hash of the first
-- frame (re-encoded/re-compressed copies of the same footage).
-- Complements the existing filename-based duplicate check, which
-- misses same-content-different-filename and different-content-
-- same-filename cases.
-- ============================================================

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS file_hash TEXT,
  ADD COLUMN IF NOT EXISTS frame_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_videos_file_hash ON videos(file_hash) WHERE file_hash IS NOT NULL;
