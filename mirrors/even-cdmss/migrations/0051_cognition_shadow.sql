-- 0051_cognition_shadow.sql — WM1 the shadow agent's one table
-- (CDMSS-WM1-SHADOW-PRD-AND-CC-KICKOFF-31-AUG-2026).
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-cognition-shadow, which runs this DDL idempotently. Mirrors
-- migrations/0050_physician_standing.sql in both form and posture.
--
-- MIGRATION NUMBER 0051. 0050 is the highest committed number; 0051 is the next free one.
--
-- ⚠️ AUTHORED, NOT TRANSCRIBED. The kickoff says "exactly the SQL in PRD §4", but the PRD file is
-- not in this working tree, so §4's literal DDL was unavailable. This schema was derived from the
-- kickoff's stated requirements (a UNIQUE constraint supporting ON CONFLICT DO NOTHING, plus every
-- column the Shadow page is specified to render). Flagged prominently in the ship report — V should
-- diff this against §4 before running it.
--
-- ⚠️ CREATE ONLY. This file ALTERs no existing table and DROPs nothing. In particular it does not
-- touch opd_note_audits, ipd_discharge_audits, clinical_states or case_ask_turns, so it cannot move
-- a score, a band, a verdict or a stored conversation. NO ENGINE BUMP anywhere.
--
-- ⚠️ NO EVEN ACCOUNT NUMBERS, NO PHI. The only identifiers stored are `event_ref` (an opaque db13
-- prescription uid) and `doctor_uid` (an internal clinician id this repo already stores on
-- opd_note_audits). No member id, no individual_uid, no UHID, no patient text. The o_status column
-- records only WHETHER the spine reconstructed — never what it contained.
--
-- ⚠️ SHADOW ONLY. No doctor-facing code path reads this table, and this ship adds no reader other
-- than the admin Shadow page. A row here is a record of what the agent WOULD have done.
--
-- cognition_shadow_events — one row per (trigger, event, policy version).
--   trigger_kind    'opd_note_audited' in v0. 'ipd_stay_extracted' is in the type union but the
--                   kickoff specifies no read for it, so this ship writes none.
--   event_ref       the deduped opd_note_audits.uid the decision was made about.
--   event_at        the note_date (falling back to audited_at) — when the world event happened.
--   microworld      'headache' | 'none'. match_rule records WHICH rule said so, so a later rule is
--                   comparable against this one rather than silently replacing it.
--   eligible        microworld = 'headache' AND doctor_uid present AND current-era engine.
--   would_ask       the burden policy's decision. FALSE is the overwhelmingly common case by design.
--   objective       'close_snapshot' when would_ask, else NULL. The other three CognitionObjective
--                   members are unreachable in v0.
--   reason          ALWAYS present. 'would_ask', or one of the five named silences
--                   (not_microworld / no_doctor / stale_era / budget_global / budget_doctor).
--                   A silence with no reason cannot be audited, so the column is NOT NULL.
--   o_status        set on would_ask rows only: ok / no_prior_history / context_fetch_failed /
--                   unresolved_identity. NULL everywhere else, because the annotation was not run.
--   policy_version  part of the UNIQUE key ON PURPOSE: bumping the policy re-shadows the backlog
--                   under the new rule, rather than leaving decisions made under the old rule to be
--                   read as if they were current.
--
-- BELIEFUPDATE IS DELIBERATELY ABSENT. WM1 defines that type and stores NOTHING of it: there is no
-- belief_updates table here and no writer anywhere in this ship.

CREATE TABLE IF NOT EXISTS cognition_shadow_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source      TEXT NOT NULL DEFAULT 'standalone',
  trigger_kind    TEXT NOT NULL,
  event_ref       TEXT NOT NULL,
  event_at        TIMESTAMPTZ,
  doctor_uid      TEXT,
  engine_version  TEXT,
  microworld      TEXT NOT NULL,
  match_rule      TEXT NOT NULL,
  eligible        BOOLEAN NOT NULL DEFAULT FALSE,
  would_ask       BOOLEAN NOT NULL DEFAULT FALSE,
  objective       TEXT,
  reason          TEXT NOT NULL,
  o_status        TEXT,
  policy_version  TEXT NOT NULL,
  schema_version  TEXT NOT NULL
);

-- The idempotence key the sweep's ON CONFLICT DO NOTHING targets.
CREATE UNIQUE INDEX IF NOT EXISTS cognition_shadow_events_identity_uq
  ON cognition_shadow_events (trigger_kind, event_ref, policy_version);

-- The global-budget seed reads eligible rows since the last would_ask, per policy version.
CREATE INDEX IF NOT EXISTS cognition_shadow_events_budget_idx
  ON cognition_shadow_events (policy_version, would_ask, created_at DESC);

-- The per-doctor daily cap reads today's asks by clinician.
CREATE INDEX IF NOT EXISTS cognition_shadow_events_doctor_idx
  ON cognition_shadow_events (doctor_uid, created_at DESC);
