-- 0044_preop_suggestions.sql — B8b's suggestion decisions (CDMSS-PREOP-RISK-AGENT B8 kickoff,
-- 27 Aug 2026). REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-preop, which runs this DDL idempotently alongside 0042's and 0043's.
--
-- ONE ROW PER CLINICAL DECISION. B7 measured the extraction rail disagreeing with itself on
-- 40% of identical texts and reading a proton-pump inhibitor as a peptic ulcer, so B8 demoted
-- the model from assertor to suggester. This table is the only path back: a suggestion becomes
-- an INPUT when — and only when — a named person, shown the verbatim source span on the case
-- page, presses Confirm.
--
-- It does two jobs and both are load-bearing:
--
--   OPERATIONAL   the sweep re-reads it and turns each `confirm` into an observation with
--                 HUMAN provenance, which is what makes a confirmation survive a recompute.
--                 `source_fingerprint` binds the decision to the exact text it was made
--                 against: if the anaesthetist edits the note, the fingerprint moves and the
--                 confirmation retires, because what was confirmed was a reading of text that
--                 no longer exists. Carrying it forward would be inventing consent.
--
--   EVIDENTIAL    this is the gold-label store the B8d promotion gate reads. A field class
--                 reaches `score` mode only after 3-read stability of 100% on the golden set,
--                 zero false tier-moves, and >= 2 weeks of decisions here at >= 95% precision
--                 on that class, ratified by V per class. Confidence does not promote; the
--                 decisions in this table do.
--
-- APPEND-ONLY. A later decision on the same (episode, input, fingerprint) supersedes an
-- earlier one at READ time via DISTINCT ON, never by UPDATE — so a clinician changing their
-- mind is itself part of the record, and the precision measurement can see it.

CREATE TABLE IF NOT EXISTS preop_suggestion_decisions (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source         TEXT NOT NULL DEFAULT 'standalone',
      episode_key        TEXT NOT NULL,
      engine_version     TEXT NOT NULL,
      input_id           TEXT NOT NULL,
      status             TEXT NOT NULL,
      span               TEXT,
      field              TEXT,
      decision           TEXT NOT NULL,
      decided_by         TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL
    );

CREATE INDEX IF NOT EXISTS preop_suggestion_decisions_episode_idx
      ON preop_suggestion_decisions (engine_version, episode_key, input_id, source_fingerprint, decided_at DESC);

CREATE INDEX IF NOT EXISTS preop_suggestion_decisions_class_idx
      ON preop_suggestion_decisions (engine_version, input_id, decision, decided_at DESC);
