-- =====================================================================
-- Migration 0133 — Arch #22: a capture-side level sequence on the level log.
-- NUMBERING: 0132 is taken by origin/herdr/arch-21-reap-alert (checked 08 Oct). If another branch also takes 0133, say so in the report; do not renumber theirs.
--
-- bench_level_sample.seq          the recorder's monotonically increasing level-sample sequence (count of index checkpoints that carried a level). It
--                                 resets when a new capture starts, so a LOWER value is a new epoch, never a stall.
-- bench_level_sample.captured_at  when the recorder wrote that checkpoint (its wall clock). NULL on every row before this migration and on every app
--                                 that does not send it; readers fall back to the identical-run rule.
--
-- ADDITIVE, NULLABLE, IDEMPOTENT. No backfill: NULL means "not reported", which is a different fact from any value. No PHI.
-- The level-log insert falls back to the old column list if these columns are absent, so deploying before this is applied loses no samples.
-- =====================================================================
ALTER TABLE bench_level_sample ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE bench_level_sample ADD COLUMN IF NOT EXISTS captured_at timestamptz;

INSERT INTO schema_migrations (version, name)
VALUES (133, '0133_level_seq')
ON CONFLICT DO NOTHING;
