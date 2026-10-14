-- 0054_cognition_review.sql — WM6 build B4: sequential review's two tables
-- (CDMSS-WM6-SEQUENTIAL-REVIEW-CC-KICKOFF-8-SEP-2026, decisions W6-D1..W6-D8; CAT Design R1-R3,
-- 8 Sep 2026).
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-cognition-review, which runs this DDL idempotently. Mirrors
-- migrations/0053_cognition_reactions.sql and 0051_cognition_shadow.sql in both form and posture.
--
-- MIGRATION NUMBER 0054. 0053 is the highest committed number; 0054 is the next free one.
--
-- The DDL below is TRANSCRIBED VERBATIM from the kickoff's "DDL (exact)" block. Nothing was
-- inferred, added or reordered.
--
-- ⚠️ CREATE ONLY. This file ALTERs no existing table and DROPs nothing. In particular it does not
-- touch cognition_shadow_events, cognition_reactions, opd_gov_signal, opd_note_audits,
-- clinical_states or member-state's sources, so it cannot move a score, a band, a verdict, a
-- governance thread, a shadow decision or a reaction. NO ENGINE BUMP anywhere.
--
-- ⚠️ NOBODY IS SCORED. A belief row is a record of what one reviewer thought at one cut, under a
-- named perturbation or none. It is not a grade, not a rating of the reviewer, and not a rating of
-- CDMSS. There is no correctness column here by construction, and nothing in this ship computes
-- one. No doctor-facing surface reads either table.
--
-- ⚠️ THE SUBJECT IS HASHED. `individual_uid_hash` is sha256(individual_uid) hex. The plain
-- individual_uid is NEVER written to either table. It exists only in the db13 reads the walk itself
-- performs, which are unchanged by this ship.
--
-- ⚠️ THE SNAPSHOT IS STORED AS THE WALK RETURNED IT. `cuts` holds the walk's cuts array — dates,
-- statuses, the frozen member-state/1.2 snapshots, fold notes and fold refusals. That is clinical
-- content about one person, de-identified and admin-only, on exactly the posture the World Model
-- walk page already carries. It is stored so a belief can be read back against precisely what the
-- reviewer was shown, which is the whole point of a retrospective replay.
--
-- cognition_review_sessions — one row per review sitting.
--   individual_uid_hash  sha256 hex of the subject's individual_uid. Never the uid itself.
--   microworld           'headache' in v1; the only microworld this ship reviews.
--   reviewer_role        consulting_physician | neurologist. A role, never a person.
--   variants             the perturbation ids chosen at start, in catalogue order. May be empty.
--   walk_version         WORLD_MODEL_WALK_VERSION at start.
--   member_state_version MEMBER_STATE_VERSION ('member-state/1.2') at start.
--   ipd_fold             'folded' | 'fold_off'. 'fold_off' is "we did not look", NOT "no stays".
--   cuts                 the walk's cuts array as returned.
--   revealed_index       how far the reviewer has been allowed to see. A revealed cut cannot be
--                        unseen, so this only ever moves forward.
--   status               active | completed | incomplete. 'incomplete' means the spine could not be
--                        read at a cut — an outage, never "the reviewer gave up".
--
-- cognition_belief_updates — one row per (session, step, variant-or-base). Immutable.
--   variant_id     NULL for the base belief; a catalogue id for a perturbed one. The unique index
--                  coalesces it to 'base' so NULL cannot be recorded twice.
--   provenance     fixed: a person's stated belief is a reported belief and nothing else.
--   trigger        fixed: 'retrospective_replay'. This is a replay of a case that already happened.
--   after_cdmss    fixed FALSE — the opposite of a reaction. The reviewer has NOT been shown a CDMSS
--                  output for this cut; they are reading the record as it stood.
--   payload        the four-field belief (ReviewBeliefPayload). Free text is the reviewer's own
--                  diagnosis wording and their 'other' investigation — never patient text.
--   seconds_spent  wall-clock on that one step, for burden measurement.

CREATE TABLE IF NOT EXISTS cognition_review_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  individual_uid_hash TEXT NOT NULL,
  microworld TEXT NOT NULL,
  reviewer_role TEXT NOT NULL,
  variants TEXT[] NOT NULL DEFAULT '{}',
  walk_version TEXT NOT NULL,
  member_state_version TEXT NOT NULL,
  ipd_fold TEXT NOT NULL,
  cuts JSONB NOT NULL,
  cut_count INTEGER NOT NULL,
  revealed_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  completed_at TIMESTAMPTZ,
  schema_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cognition_review_sessions_subject_idx
  ON cognition_review_sessions (individual_uid_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS cognition_belief_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id UUID NOT NULL REFERENCES cognition_review_sessions(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  cut_date DATE NOT NULL,
  variant_id TEXT,
  reviewer_role TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'CLINICIAN_REPORTED_BELIEF',
  trigger TEXT NOT NULL DEFAULT 'retrospective_replay',
  after_cdmss BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL,
  seconds_spent INTEGER NOT NULL,
  schema_version TEXT NOT NULL
);

-- One belief per (session, step, base-or-variant). The ON CONFLICT DO NOTHING target of
-- insertBelief: NULL variant_id coalesces to 'base', so the base belief cannot be recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS cognition_belief_updates_step_uq
  ON cognition_belief_updates (session_id, step_index, COALESCE(variant_id, 'base'));
