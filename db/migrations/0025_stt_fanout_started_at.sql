-- =====================================================================
-- Migration 0025 — STT Engine Lab: per-job claim timestamp.
-- Adds stt_fanout_job.started_at so drainFanout() can reclaim ONLY stale
-- 'running' jobs (worker killed/timed-out) instead of blanket-resetting every
-- running job — which let a second concurrent drain re-claim a job another
-- drain was still processing (double-processing that dedupRuns had to clean up).
-- Additive + idempotent. Nothing in the doctor path changes.
-- =====================================================================
ALTER TABLE stt_fanout_job ADD COLUMN IF NOT EXISTS started_at timestamptz;
