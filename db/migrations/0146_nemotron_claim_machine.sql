-- 0146_nemotron_claim_machine.sql — HF overflow (epic #23, split from the timeline build): which machine holds a claim.
--
-- Additive and idempotent; no grants. The HF daily cost cap is enforced at claim time from recorded HF minutes
-- (diarize_nemotron_window.machine = 'hf', audio_ms) PLUS the live, unfinished HF claims (this column), so a batch in
-- flight counts against the cap before its rows are ingested. 'box' is the default, so every existing claim is a box claim.

BEGIN;

ALTER TABLE diarize_nemotron_claim ADD COLUMN IF NOT EXISTS machine text NOT NULL DEFAULT 'box';

ALTER TABLE diarize_nemotron_claim DROP CONSTRAINT IF EXISTS diarize_nemotron_claim_machine_chk;
ALTER TABLE diarize_nemotron_claim ADD CONSTRAINT diarize_nemotron_claim_machine_chk CHECK (machine IN ('box', 'hf'));

COMMENT ON COLUMN diarize_nemotron_claim.machine IS
  'box | hf: the machine class of the worker that holds (or last held) the claim. Set by /pending from its machine parameter; used to count in-flight HF work against NEMO_HF_DAILY_USD_CAP.';

INSERT INTO schema_migrations (version, name)
VALUES (146, '0146_nemotron_claim_machine')
ON CONFLICT DO NOTHING;

COMMIT;
