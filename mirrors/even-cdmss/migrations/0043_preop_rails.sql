-- 0043_preop_rails.sql — the Pre-op Risk Agent's two LLM rails (PRD v1.1-LOCKED §7 / D4;
-- Build Plan B5 + B6). REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-preop, which runs this DDL idempotently alongside 0042's.
--
-- Both rails ship behind flags that are OFF, and both write into columns that are
-- DELIBERATELY OUTSIDE the snapshot fingerprint. That is the schema-level half of the D4
-- proof: no artefact written here can move a score or mint a snapshot version, because
-- nothing here is read by snapshotFingerprint() and nothing here is written by
-- saveSnapshot().
--
--   extraction              the stored reading: accepted inputs with their verbatim source
--                           spans and confidences, the rejected proposals with the gate
--                           that rejected each, the polarity marks, and the unstable list.
--   extraction_fingerprint  fnv1a over the SOURCE TEXT the reading was made from. This is
--                           the anti-flap key: unchanged text ⇒ the stored reading is
--                           reused verbatim and NO MODEL RUNS. Not the episode, not the
--                           clock, not the model — only the text.
--   extraction_model        the DERIVED model label (read back off the call's own trace),
--   extraction_provider     never the one we asked for. NULL when no call was made.
--   extracted_at            when the reading was taken.
--
--   narrative               the model's prose, stored whether or not CODE accepted it.
--   narrative_fingerprint   the SNAPSHOT fingerprint it was written for. A narrative whose
--                           fingerprint no longer matches the live row has fallen behind
--                           its own score and is not rendered — detectable, not merely old.
--   narrative_model         DERIVED, as above. A call that came back from a model other
--   narrative_provider      than the one asked for stores NOTHING at all (DEC-2).
--   narrative_at            when it was written.
--   narrative_valid         CODE's verdict on citation integrity. An invalid narrative is
--                           kept for review and never rendered (the R4-4 contract).
--
-- Additive and nullable throughout: every row written before B5 reads NULL and behaves
-- exactly as it did before these columns existed.

ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction             JSONB;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction_fingerprint TEXT;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction_model       TEXT;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extraction_provider    TEXT;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS extracted_at           TIMESTAMPTZ;

ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative              JSONB;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_fingerprint  TEXT;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_model        TEXT;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_provider     TEXT;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_at           TIMESTAMPTZ;
ALTER TABLE preop_findings ADD COLUMN IF NOT EXISTS narrative_valid        BOOLEAN;
