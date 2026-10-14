-- 0049_stay_library_hardening.sql — the stay library's hardening pieces
-- (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026, H-D2 / H-D7 / H-D11).
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-stay-library-hardening, which runs this DDL idempotently.
-- 0048 is taken (readmission_retrieved_artefacts); this is the next free number.
--
-- ONE migration for H1 and H3 (H-D11 explicitly allows it, "builder's call"): a single route the
-- operator runs once is safer than two they can run in the wrong order, and every statement is
-- additive — CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS. Running it twice is the same as
-- running it once. It touches NO other table: no audit, no feedback, no episode, no member state,
-- and no engine version string anywhere. H1 fills the first section; H3 appends the second.
--
-- ⚠️ INFERRED DDL: this sandbox has no live Neon. Every statement here is listed verbatim in the
-- slice report for orchestrator validation against the real database.

-- ── H1 (H-D2): the prior reading of a library row, kept before it is overwritten ────────────
--
-- WHY. `upsertClinicalState` overwrites in place. P2.1 rewrote 24 rows that way, and with
-- MEMBERSTATE_IPD_FOLD on since 28 Aug the spine is computed at read time from these rows — so a
-- library overwrite silently changes a member's snapshot with nothing to diff against. This table
-- is the diff trail. Its row is written in the SAME SQL STATEMENT as the overwrite (a CTE), so a
-- crash can never leave an overwrite with no snapshot behind it, and a FAILED snapshot BLOCKS the
-- overwrite: the whole statement aborts and the store returns its fail-soft 'skipped'.
--
--   reason  a closed set of exactly two:
--           'upsert_overwrite' — the row the upsert's DO UPDATE arm was about to replace;
--           'superseded'       — an absence row H3's re-look retired because the substrate finally
--                                arrived (the real row is a NEW row; the absence row is UPDATEd,
--                                never deleted).
--
-- state_json holds the WHOLE prior ClinicalState so a future schema's fields never go stale; the
-- scalar columns are copies for querying. A fresh INSERT snapshots nothing — there was no prior
-- reading, and inventing an empty one would put a row on the trail that never existed.
--
-- NOTHING USER-FACING READS THIS TABLE. It is a trail, not a surface.

CREATE TABLE IF NOT EXISTS clinical_state_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshotted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clinical_state_id UUID NOT NULL,
  doc_kind          TEXT NOT NULL,
  source_uid        TEXT NOT NULL,
  schema_version    TEXT NOT NULL,
  status            TEXT NOT NULL,
  state_json        JSONB NOT NULL,
  reason            TEXT NOT NULL
);
-- The read this table exists for: every prior reading of ONE library row, oldest first.
CREATE INDEX IF NOT EXISTS clinical_state_versions_state_idx
  ON clinical_state_versions (clinical_state_id, snapshotted_at);

-- ── H3 (H-D7): "looked on date X and absent" vs "never looked" ──────────────────────────────
--
-- Additive columns on `clinical_states`. `not_auditable` was forever: 32 of R10's 45 blind cases
-- were rows that arrived in db13 AFTER the audit ran, so IP-1472's absent OT row would never be
-- re-checked and a late-arriving operative note never reaches the stay audit or the spine. Without
-- last_checked_at an absence row cannot say when it was last looked for, and a re-look has no
-- oldest-first order to walk.
--
--   last_checked_at  NULL means NEVER RE-LOOKED, which is not the same as "checked and still empty".
--                    The walk orders NULLS FIRST precisely because a never-looked row is the most
--                    interesting one. Nullable on purpose: a DEFAULT NOW() would backdate a look
--                    that never happened onto every row already on the table.
--   check_count      NOT NULL DEFAULT 0 — how many times we have looked. Zero is honest for every
--                    row that exists today.
--   superseded_by    the id of the REAL row that replaced this absence. Absence rows are NEVER
--                    DELETED (H-D8): "we looked on 29 August and it was not there" stays true after
--                    the note turns up, and deleting the row would erase the evidence that we
--                    looked — the exact confusion between "nobody built this stay" and "this stay
--                    has no OT note" that the absence row was created to prevent.
--                    No FOREIGN KEY: a fail-soft store must never have a write rejected by a
--                    constraint, and clinical_state_versions is where the real integrity story is.

ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS check_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS superseded_by   UUID;
-- The re-look's own walk: absence rows, oldest-checked first, without a sequential scan.
CREATE INDEX IF NOT EXISTS clinical_states_relook_idx
  ON clinical_states (status, last_checked_at, created_at);
