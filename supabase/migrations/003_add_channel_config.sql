-- ============================================================
-- Channel-specific metadata rules, configurable per the automation
-- settings rather than hardcoded in the prompt.
-- ============================================================

ALTER TABLE automation_settings
  ADD COLUMN IF NOT EXISTS max_keywords INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS max_hashtags INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS title_style TEXT NOT NULL DEFAULT 'curiosity_with_accuracy';
