-- 0062_ot_nabh_scores.sql — additive NABH completeness columns on ot_note_audits.
--
-- Engine ot-nabh/0.1 is distinct from the lander engine ot-note-audit/0.1.
-- Lander `findings` / `n_findings` are not rewritten and are not the NABH rubric.
-- Does not set TRIAGE_BOT_WRITE. Does not set TRIAGE_BOT_WRITE_CLASSES.
-- Does not enable note_class=ot route mint.

ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_score_sum INT;
ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_score_max INT;
ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_score_pct NUMERIC(6,2);
ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_criteria JSONB;
ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_engine_version TEXT;
ALTER TABLE ot_note_audits ADD COLUMN IF NOT EXISTS nabh_scored_at TIMESTAMPTZ;
