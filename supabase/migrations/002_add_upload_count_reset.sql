-- ============================================================
-- Adds a manual "reset today's upload limit" marker.
-- Uploads before this timestamp are excluded from today's count,
-- without deleting real upload_history records.
-- ============================================================

ALTER TABLE automation_settings
  ADD COLUMN IF NOT EXISTS upload_count_reset_at TIMESTAMPTZ;
