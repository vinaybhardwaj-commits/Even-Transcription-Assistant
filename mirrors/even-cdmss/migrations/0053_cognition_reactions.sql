-- 0053_cognition_reactions.sql — WM2 v1 build B2a: the reaction store
-- (CDMSS-WM2-V1-REACTION-STORE-CC-KICKOFF-8-SEP-2026, decisions V1-D1..V1-D10).
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-cognition-reactions, which runs this DDL idempotently. Mirrors
-- migrations/0051_cognition_shadow.sql in both form and posture.
--
-- MIGRATION NUMBER 0053. 0052 is the highest committed number; 0053 is the next free one.
--
-- The DDL below is TRANSCRIBED VERBATIM from the kickoff's "DDL (exact)" block. Nothing was
-- inferred, added or reordered.
--
-- ⚠️ CREATE ONLY. This file ALTERs no existing table and DROPs nothing. In particular it does not
-- touch opd_gov_signal, opd_gov_signal_event, opd_audit_feedback, opd_note_audits or
-- cognition_shadow_events, so it cannot move a score, a band, a verdict, a governance thread or a
-- shadow decision. NO ENGINE BUMP anywhere.
--
-- ⚠️ NO PHI, EVER. The only identifiers stored are `signal_id` and `reference` (a governance
-- thread), `cdmss_doctor_uid` (an internal clinician id this repo already stores on
-- opd_note_audits), `physician_id` (the physician-directory identity) and `clinical_state_ref` (an
-- opd_note_audits row id). Never store patient identifiers, note text, or comments in this table.
-- There is no free-text column and no comment column, by construction.
--
-- ⚠️ THIS TABLE NOTIFIES NOBODY. A reaction is a belief record, provenance
-- CLINICIAN_REPORTED_BELIEF, written when a doctor presses one of three non-escalating buttons on
-- a Findings card. It escalates nothing, it opens no thread, and no CM or governance surface reads
-- it. The one reader this ship adds is the admin World Model page's Reactions block.
--
-- cognition_reactions — one row per (signal, physician). Immutable and replay-safe.
--   signal_id          the opd_gov_signal thread the card was showing.
--   reference          that thread's EHRC-AUD-YYYY-NNNN, copied at write time so a reaction can be
--                      read without a join.
--   clinical_state_ref the representative opd_note_audits row id at the time of the reaction, or
--                      NULL when it could not be resolved. NULL means "not resolved", never "none".
--   cdmss_doctor_uid   the CDMSS-side clinician identity (opd_note_audits.doctor_uid).
--   physician_id       the physician-directory identity, kept in its own column because the two
--                      namespaces are not the same one (lib/cognition/schema.ts, BeliefUpdate).
--   reaction           the controlled vocabulary REACTION_VERBS: already_knew | surprised |
--                      dismiss. Enforced in code (isReactionVerb), not by a CHECK constraint —
--                      the kickoff's DDL is exact and carries none.
--   provenance         fixed by construction. A person's stated reaction is a reported belief and
--                      nothing else; it is never a patient fact and never a CDMSS inference.
--   after_cdmss        TRUE for every row this route writes — the button only exists on a card the
--                      clinician is already looking at.
--   surface            where the press happened. 'portal_findings' is the only writer in v1.
--   schema_version     REACTION_SCHEMA_VERSION ('reaction/0.1'). Distinct from
--                      COGNITION_SCHEMA_VERSION, which stays 'cognition/0.1'.
--
-- THE IDENTITY KEY IS (signal_id, physician_id) AND IT IS GLOBAL — app_source is deliberately NOT
-- part of it. One physician gets one reaction per signal, whichever deployment recorded it. No
-- read in lib/cognition/reactions-store.ts filters on app_source, because a read that filtered
-- could return NULL for a row the unique index would still refuse to write.

CREATE TABLE IF NOT EXISTS cognition_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source TEXT NOT NULL DEFAULT 'standalone',
  signal_id UUID NOT NULL,
  reference TEXT NOT NULL,
  clinical_state_ref TEXT,
  cdmss_doctor_uid TEXT NOT NULL,
  physician_id TEXT NOT NULL,
  reaction TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'CLINICIAN_REPORTED_BELIEF',
  after_cdmss BOOLEAN NOT NULL DEFAULT TRUE,
  surface TEXT NOT NULL DEFAULT 'portal_findings',
  schema_version TEXT NOT NULL
);

-- One reaction per signal per physician. The ON CONFLICT DO NOTHING target of insertReaction.
CREATE UNIQUE INDEX IF NOT EXISTS cognition_reactions_identity_uq
  ON cognition_reactions (signal_id, physician_id);

-- The per-doctor read (listReactionsFor, and the WM3 join).
CREATE INDEX IF NOT EXISTS cognition_reactions_doctor_idx
  ON cognition_reactions (cdmss_doctor_uid, created_at DESC);
