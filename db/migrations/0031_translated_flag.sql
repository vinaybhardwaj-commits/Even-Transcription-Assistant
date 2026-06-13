-- =====================================================================
-- Migration 0031 — `translated` flag so /process is RESUMABLE: a re-run skips
-- the expensive Sarvam batch translate when it already ran. Lets long (>5min)
-- recordings finish across multiple invocations (each capped at Vercel's 300s)
-- driven by the resume cron, instead of dying once and stranding in 'processing'.
-- =====================================================================
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS translated boolean NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version, name) VALUES (31, '0031_translated_flag') ON CONFLICT DO NOTHING;
