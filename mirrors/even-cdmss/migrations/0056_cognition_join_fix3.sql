-- 0056_cognition_join_fix3.sql — WM3 join, fix 3: stale-era notes, the raw-note trigger, the
-- stability check (CDMSS-WM3-JOIN-FIX3-CC-KICKOFF-9-SEP-2026 §4; CAT Design memo
-- CDMSS-CAT-DESIGN-MEMO-WM6-NARRATIVE-AND-WINDOW-8-SEP-2026, rulings N5, N6, N8 and Addendum A).
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-cognition-join, which runs this DDL idempotently alongside 0055's.
--
-- MIGRATION NUMBER 0056. 0055 is the highest committed number; 0056 is the next free one.
--
-- The DDL below is TRANSCRIBED VERBATIM from the kickoff's "Schema, exact" block. Nothing was
-- inferred, added or reordered.
--
-- ⚠️ ADDITIVE ONLY. This file DROPs nothing, retypes nothing and rewrites no value. It touches
-- exactly one existing table — cognition_triples, with one ADD COLUMN IF NOT EXISTS — and creates
-- one index and one new table. It does not touch cognition_shadow_events, cognition_reactions,
-- cognition_review_sessions, cognition_belief_updates, opd_note_audits, clinical_states or anything
-- the frozen spine reads, so it cannot move a score, a band, a verdict, a shadow decision, a
-- reaction or a belief. NO ENGINE BUMP anywhere.
--
-- ⚠️ NO SCHEMA-VERSION BUMP. JOIN_SCHEMA_VERSION stays 'cognition-join/0.1'. The new column is
-- NOT NULL WITH A DEFAULT, so every triple written before this migration becomes 'current' with no
-- backfill — and 'current' is precisely what those rows are, every one of them having been opened
-- from an ELIGIBLE shadow event. No existing row's meaning changes, so re-opening the backlog under
-- a new version would be a cost with nothing bought.
--
-- ⚠️ THE STABILITY TABLE CARRIES PHI BY REFERENCE. `triple_ids` and `mismatched_ids` are lists of
-- cognition_triples ids, and a triple is one identified member's note. Not readable by the Lab
-- research scope, and nothing here goes into the Lab store.
--
-- era_status — WHICH BACKLOG A TRIPLE CAME OUT OF, and therefore what its presence is evidence of.
--   current    opened from an eligible shadow event: audited, current-era, judged by the burden
--              policy. The only value existing rows can have, hence the default.
--   stale      opened from a shadow event the policy refused with reason 'stale_era' — the note WAS
--              audited, by an engine version that is no longer current. The refusal was about
--              whether the agent should speak, never about whether the note happened.
--   unaudited  opened by the raw-note trigger (trigger_kind 'opd_note_matched', rule
--              'headache-raw/1') from a db13 note with no audit row at all.
--   The three are NEVER collapsed: a rate over 'current' alone and a rate over all three have
--   different denominators, and a reader who cannot tell them apart will believe the wrong one.
--
-- cognition_join_stability — one row per stability run (N5). APPEND-ONLY.
--   sample_n / matched_n / failed_n
--                  the 30 oldest resolved triples with an 'ok' O_before are re-reconstructed
--                  through the frozen getMemberSnapshotAsOf at the stored as_of and re-hashed.
--                  A THROW is `failed` and comes OUT of the denominator: a reading we could not
--                  take is not evidence that the reconstruct moved. match_rate is therefore
--                  matched_n / (sample_n - failed_n), and is NULL — not 0% — when that is zero.
--   triple_ids     what was sampled, so a later run can be compared against the same rows.
--   mismatched_ids the ones whose re-reconstruction hashed differently. Evidence to look at, never
--                  a correction to apply: the run writes NOTHING to cognition_snapshots, because
--                  overwriting the stored snapshot would destroy the thing that made drift visible.
--   walk_version / member_state_version
--                  the versions the re-reconstruction ran under, so a drift caused by a version
--                  change is distinguishable from a drift caused by db13 moving underneath.

ALTER TABLE cognition_triples ADD COLUMN IF NOT EXISTS era_status TEXT NOT NULL DEFAULT 'current';

CREATE INDEX IF NOT EXISTS cognition_triples_era_idx ON cognition_triples (era_status, trigger_kind);

CREATE TABLE IF NOT EXISTS cognition_join_stability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sample_n INTEGER NOT NULL,
  matched_n INTEGER NOT NULL,
  failed_n INTEGER NOT NULL,
  triple_ids JSONB NOT NULL,
  mismatched_ids JSONB NOT NULL,
  walk_version TEXT NOT NULL,
  member_state_version TEXT NOT NULL,
  schema_version TEXT NOT NULL
);
