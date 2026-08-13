-- ============================================================
-- Persists independent-verifier results alongside the generated
-- metadata, so the dashboard can show whether metadata was actually
-- verified (and what, if anything, got flagged/revised) instead of
-- that information only existing transiently in logs.
-- ============================================================

ALTER TABLE ai_metadata
  ADD COLUMN IF NOT EXISTS verification_approved BOOLEAN,
  ADD COLUMN IF NOT EXISTS verification_score INTEGER,
  ADD COLUMN IF NOT EXISTS verification_issues JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS verification_invalid_keywords JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS verification_revised BOOLEAN DEFAULT false;
