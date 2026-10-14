-- 0055_cognition_join.sql — WM3 build B3: the join's two tables
-- (CDMSS-WM3-JOIN-CC-KICKOFF-8-SEP-2026, decisions D1-D4; CAT Design rulings Q1-Q5, 8 Sep 2026).
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-cognition-join, which runs this DDL idempotently. Mirrors
-- migrations/0051_cognition_shadow.sql in both form and posture.
--
-- MIGRATION NUMBER 0055. 0054 is the highest committed number; 0055 is the next free one.
--
-- The DDL below is TRANSCRIBED VERBATIM from the kickoff's "DDL (exact)" block. Nothing was
-- inferred, added or reordered.
--
-- ⚠️ CREATE ONLY. This file ALTERs no existing table and DROPs nothing. In particular it does not
-- touch cognition_shadow_events, cognition_reactions, cognition_review_sessions,
-- cognition_belief_updates, opd_note_audits, clinical_states or anything the frozen spine reads,
-- so it cannot move a score, a band, a verdict, a shadow decision, a reaction or a belief.
-- NO ENGINE BUMP anywhere.
--
-- ⚠️ BOTH TABLES CARRY PHI. `cognition_snapshots.individual_uid` is a plain individual_uid and
-- `snapshot_json` is a whole member-state/1.2 spine snapshot. `cognition_triples` carries the same
-- uid and db13 lab identifiers. This is the first PERSISTED snapshot in the programme: until now
-- the spine was always reconstructed on demand and never written down. These tables are NOT
-- readable by the Lab research scope, and nothing here goes into the Lab store.
--
-- ⚠️ THE FROZEN SPINE IS UNCHANGED. Every snapshot is produced by calling the frozen
-- getMemberSnapshotAsOf for one date, through the same path the World Model walk uses for one cut.
-- This ship adds a WRITER of what that function returns; it does not change what it returns, and
-- member-state/1.2 is not bumped.
--
-- ⚠️ THE visible_at RULE APPLIES TO Y ONLY. O_before and O_after are as-of reconstructions and
-- carry the walk's existing honesty: dated by clinical date, result-availability lag NOT modelled.
-- Y is the one field in this programme where the lag IS modelled, and `y_visible_rule` records
-- which of the two rules produced it, because a row whose lag could not be modelled
-- (`test_date_only`, pre-13-July-2023 or a null _create_time) must never be read as one whose was.
--
-- cognition_snapshots — one row per (individual, as_of, versions, fold, provenance).
--   as_of          the reconstruction day. The spine's cut is STRICTLY PRIOR to it: a snapshot
--                  as_of the note day does not contain the note day's own evidence.
--   cut_status     the walk's own three statuses. `context_fetch_failed` is "we could not read",
--                  NOT "there was nothing" — and on such a row snapshot_json is NULL rather than an
--                  empty state, because an empty state would be a claim we cannot make.
--   provenance     captured (the event arrived after the join was live) | reconstructed (we are
--                  looking backwards at it). Part of the identity key: the same day captured live
--                  and reconstructed later are two different pieces of evidence.
--   snapshot_json  the frozen member-state/1.2 snapshot as returned. NULL when cut_status is not
--                  'ok'. Fold notes and fold refusals have no column here and are not persisted.
--   ipd_fold       folded | fold_off. 'fold_off' is "we did not look", NOT "no stays".
--
-- cognition_triples — one row per (trigger_kind, event_ref, schema_version). One eligible note.
--   individual_uid NULLABLE on purpose: a note that does not resolve still gets a row, with
--                  resolve_status 'unresolved', so an unresolvable note is a recorded fact rather
--                  than a silently missing one.
--   y_*            the first result that became VISIBLE after the note, within the horizon.
--   y_status       pending (not yet known) | present | missing_within_horizon (we looked, the
--                  horizon passed, nothing arrived). A conclusion and an absence of one, kept apart.
--   o_after_as_of  the IST day AFTER y_visible_at — the first day whose strictly-prior cut can
--                  contain Y.
--   reaction_ref   a cognition_reactions row whose clinical_state_ref is this event. No FK: the
--                  reaction is written by a different ship on a different schedule, and a missing
--                  parent must not block a triple.
--   policy_version the burden policy the shadow decision was made under. Carried so a triple is
--                  always readable against the rule that selected it.

CREATE TABLE IF NOT EXISTS cognition_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  individual_uid TEXT NOT NULL,
  as_of DATE NOT NULL,
  cut_status TEXT NOT NULL,
  provenance TEXT NOT NULL,
  walk_version TEXT NOT NULL,
  member_state_version TEXT NOT NULL,
  ipd_fold TEXT NOT NULL,
  snapshot_json JSONB,
  snapshot_hash TEXT,
  schema_version TEXT NOT NULL
);

-- The capture's identity. Re-capturing the same day under the same versions and fold is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS cognition_snapshots_identity_uq
  ON cognition_snapshots (individual_uid, as_of, walk_version, member_state_version, ipd_fold, provenance);

CREATE TABLE IF NOT EXISTS cognition_triples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_kind TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  individual_uid TEXT,
  microworld TEXT NOT NULL,
  provenance TEXT NOT NULL,
  resolve_status TEXT NOT NULL,
  o_before_id UUID REFERENCES cognition_snapshots(id),
  y_kind TEXT,
  y_ref TEXT,
  y_test_date TIMESTAMP,
  y_create_time TIMESTAMPTZ,
  y_visible_at TIMESTAMPTZ,
  y_visible_rule TEXT,
  y_status TEXT NOT NULL,
  y_horizon_days INTEGER NOT NULL DEFAULT 14,
  o_after_id UUID REFERENCES cognition_snapshots(id),
  o_after_as_of DATE,
  reaction_ref UUID,
  reaction_after_cdmss BOOLEAN,
  policy_version TEXT NOT NULL,
  schema_version TEXT NOT NULL
);

-- One triple per event per schema version. The ON CONFLICT DO NOTHING target of phase 1.
CREATE UNIQUE INDEX IF NOT EXISTS cognition_triples_identity_uq
  ON cognition_triples (trigger_kind, event_ref, schema_version);

-- Phases 2 and 3 both read by status, oldest-touched first.
CREATE INDEX IF NOT EXISTS cognition_triples_status_idx
  ON cognition_triples (y_status, updated_at);
