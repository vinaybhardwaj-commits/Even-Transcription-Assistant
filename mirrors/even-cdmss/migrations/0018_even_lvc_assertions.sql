-- 0018_even_lvc_assertions.sql — Even LLM-Provenance LVC Adjudication System, Phase 1
-- (CDMSS-EVEN-LVC-ADJUDICATION-SYSTEM-PRD-v1.0 §3). Reference DDL — the authoritative applier is the
-- in-app admin route POST /api/admin/migrate-even-lvc (idempotent IF NOT EXISTS), run BEFORE the deploy
-- that inserts the new opd_audit_feedback columns (the documented column-add gotcha). Additive + safe:
-- no existing table/column is altered destructively; the assertion library + gen-runs are new; the
-- opd_audit_feedback ALTERs are ADD COLUMN IF NOT EXISTS (legacy rows unaffected).

-- §3.1 — the versioned, category-tagged assertion library (authority = Even physician ratification)
CREATE TABLE IF NOT EXISTS even_lvc_assertions (
  id             TEXT PRIMARY KEY,                       -- elv-<lvc_category>-<ordinal>
  artifact_type  TEXT NOT NULL DEFAULT 'opd_note',
  lvc_category   TEXT NOT NULL,                          -- one of the engine 0.81.x lvc sub-tags
  assertion_text TEXT NOT NULL,                          -- the appropriateness statement (LLM-proposed, possibly edited)
  rationale      TEXT,                                   -- model rationale (display only)
  supporting     JSONB NOT NULL DEFAULT '[]',            -- [{subject, count}] de-identified cluster exemplars (NO PHI)
  status         TEXT NOT NULL DEFAULT 'pending',        -- pending | active | contested | retired | rejected
  version        INT  NOT NULL DEFAULT 1,
  generated_by   TEXT,                                   -- 'moonshotai/kimi-k3'
  ratified_by    TEXT,                                   -- roster name
  ratified_at    TIMESTAMPTZ,
  own_cases      BOOLEAN NOT NULL DEFAULT false,
  contest_count  INT NOT NULL DEFAULT 0,
  chunk_item_number TEXT,                                -- = id when embedded into mksap_chunks
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS even_lvc_status_idx   ON even_lvc_assertions (status);
CREATE INDEX IF NOT EXISTS even_lvc_category_idx ON even_lvc_assertions (lvc_category);

-- §3.2 — generation runs (idempotency + observability)
CREATE TABLE IF NOT EXISTS even_lvc_gen_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running',          -- running | ok | error | skipped
  n_candidates INT DEFAULT 0,
  trigger      TEXT,                                     -- 'manual' | 'cron'
  error        TEXT
);

-- §3.3 — additive contest tag on the existing feedback table (scope gains value 'assertion_contest',
-- which is free-text TEXT — no enum DDL). Run BEFORE the deploy that inserts these columns.
ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS assertion_id      TEXT;
ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS assertion_version INT;
CREATE INDEX IF NOT EXISTS opd_audit_feedback_assertion_idx ON opd_audit_feedback (assertion_id);
