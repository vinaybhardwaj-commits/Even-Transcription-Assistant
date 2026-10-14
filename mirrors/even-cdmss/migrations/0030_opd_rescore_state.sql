-- The `direction` dead-path fix (PRD 29 Jul 2026, §2.1) — the re-score WATERMARK.
--
-- `concept_id` is written by the concept tick AFTER the audit row lands, so the fresh-LLM path can
-- never stamp `direction` (measured: 52 prefixed findings, zero directions). The fix is a separate
-- watermarked re-score pass (D-1) that drives the reuse path — where stampDirection already fires.
--
-- `based_on_coded_at` is the WHOLE race guard (D-3): it records WHICH concept stamp the re-score
-- was computed from — the coded_at read at candidate selection, never now(), never a re-read.
-- A concept tick landing mid-flight advances even_concept_state.coded_at past it, so the note is
-- re-selected on the next pass and a clobbered `direction` self-heals. No locks.
--
-- index/band before/after are observability for the pass's own report; band_* record what a
-- clinician actually sees (displayed_band where migration 0029 has run, raw band otherwise).
--
-- Additive, idempotent. Run by hand in the Neon SQL Editor immediately after the deploy is READY
-- and BEFORE /api/admin/opd-rescore-direction is first invoked. The route tolerates this not yet
-- having run (empty report, never a 500).
CREATE TABLE IF NOT EXISTS opd_rescore_state (
  uid                TEXT        NOT NULL,
  engine_version     TEXT        NOT NULL,
  based_on_coded_at  TIMESTAMPTZ NOT NULL,
  rescored_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  index_before       INTEGER,
  index_after        INTEGER,
  band_before        TEXT,
  band_after         TEXT,
  PRIMARY KEY (uid, engine_version)
);
