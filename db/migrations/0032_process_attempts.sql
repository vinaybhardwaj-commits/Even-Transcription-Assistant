-- Bounded retry counter for the background step-machine (/process step-mode).
-- Each background invocation runs ONE pipeline step; this counts attempts so a
-- permanently-failing step gives up (status='failed') instead of looping forever.
-- Reset to 0 whenever a step makes progress.
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS process_attempts integer NOT NULL DEFAULT 0;
