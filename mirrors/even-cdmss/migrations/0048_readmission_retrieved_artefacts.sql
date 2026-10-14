-- 0048_readmission_retrieved_artefacts.sql — R10-B: the persisted retrieved-artefact store
-- (CDMSS-READMISSIONS-R10-RECORD-REACH-PRD-27-AUG-2026-GO §4.2, R10-D6 / R10-D7 / R10-D8).
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-readmission-records, which runs this DDL idempotently.
--
-- NO ENGINE BUMP. READMIT_ENGINE_VERSION stays 'readmission/0.2' and DOC_EXTRACT_VERSION is a
-- separate contract (bumped by R10-A). Nothing detected, audited, judged or scored changes here:
-- this is storage for evidence a care manager pulled into a conversation.
--
-- WHAT IT IS FOR. The Ask agent can now fetch this patient's OTHER records mid-conversation. Those
-- artefacts cite in a SECOND namespace (`X…`) that never touches the audited ledger. Storing each
-- one AT FIRST FETCH is what makes that namespace honest:
--   · a citation resolves to the same artefact on reload, not to whatever a re-fetch returns today;
--   · an id, once bound to an artefact, stays bound (source_key is the binding);
--   · re-fetch drift mid-thread is impossible, because a stored artefact is never rewritten.
--
--   artefact_id   'X<n>' — the citable id, unique per (dedup_key, engine_version)
--   source_key    the artefact's own stable key (kind + native uid). The SECOND unique key: it is
--                 what stops one artefact being minted twice under two different ids.
--   kind          ip_stay | opd_note | lab | member_state | cm_interaction  (R10-D4's five)
--   content       ALREADY DE-IDENTIFIED on arrival (R10-D8): every retrieved string goes through
--                 lib/readmission/assemble.ts deidText before it reaches this table or a prompt.
--                 No patient name, no UHID, no encounter id — the same rule as readmission_ask_turns.
--   turn_id       the ask turn that pulled it in, when known — the audit trail for WHO fetched WHAT.
--
-- ⚠️ INFERRED SQL/DDL: this sandbox has no live Neon.

CREATE TABLE IF NOT EXISTS readmission_retrieved_artefacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedup_key       TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  artefact_id     TEXT NOT NULL,
  source_key      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  artefact_date   TEXT,
  label           TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL,
  actor           TEXT,
  turn_id         TEXT
);

-- R10-D7, both halves. The id key makes a citation resolvable and stable; the source_key key makes
-- the binding one-to-one, so an artefact already in the thread is re-used rather than re-minted.
-- Both are what `ON CONFLICT DO NOTHING` conflicts ON in saveRetrievedArtefact — first fetch wins.
CREATE UNIQUE INDEX IF NOT EXISTS readmission_retrieved_artefacts_id_idx
  ON readmission_retrieved_artefacts (dedup_key, engine_version, artefact_id);
CREATE UNIQUE INDEX IF NOT EXISTS readmission_retrieved_artefacts_source_idx
  ON readmission_retrieved_artefacts (dedup_key, engine_version, source_key);
