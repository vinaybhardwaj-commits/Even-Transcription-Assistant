-- 0020_lvc_concepts.sql — Concept Coder Phase 1 (CDMSS-CONCEPT-CODER-PRD v1.0 §3).
-- Applied by hand via POST /api/admin/migrate-lvc-concepts. Idempotent.
--
-- THREE tables per the Phase 1 kickoff. PRD §3 also specifies `lvc_concept_evidence` (per-note
-- membership marks) — that belongs to the evidence drawer, which is Phase 2, and is deliberately NOT
-- created here. Plus `even_concept_state`, the resumable watermark the worker drains against
-- (mirrors even_ground_state).
--
-- Nothing in this migration touches opd_note_audits' scoring columns. The coder's only write to that
-- table is an additive jsonb update of findings[].concept_id / .concept_context.

-- the governed vocabulary
CREATE TABLE IF NOT EXISTS lvc_concepts (
  concept_id   TEXT PRIMARY KEY,               -- direction:action:target
  direction    TEXT NOT NULL,                  -- overuse | underuse | documentation | process
  action       TEXT NOT NULL,
  target       TEXT NOT NULL,
  n_strings    INT  NOT NULL DEFAULT 0,
  volume       INT  NOT NULL DEFAULT 0,
  review_lane  TEXT NOT NULL DEFAULT 'clean',  -- clean | context (PRD §4, recomputable)
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lvc_concepts_lane_idx      ON lvc_concepts (review_lane, volume DESC);
CREATE INDEX IF NOT EXISTS lvc_concepts_direction_idx ON lvc_concepts (direction);

-- the governance record, append-only
CREATE TABLE IF NOT EXISTS lvc_concept_rulings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id      TEXT NOT NULL REFERENCES lvc_concepts (concept_id),
  context         TEXT,                        -- NULL ⇒ applies to the whole concept; most specific wins
  verdict         TEXT NOT NULL,               -- low_value | not_low_value | conditional
  rationale       TEXT NOT NULL,               -- mandatory (PRD §3)
  ratified_by     TEXT NOT NULL,               -- named (PRD §3)
  ratified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  -- Evidence columns, all mandatory (PRD §3): they exist so a later reader can distinguish a ruling
  -- made on evidence from one made on a label. reviewed_n = 0 is a ruling on an abstraction.
  sample_size     INT NOT NULL,
  reviewed_n      INT NOT NULL,
  sample_seed     TEXT NOT NULL,
  n_not_belonging INT NOT NULL
);
CREATE INDEX IF NOT EXISTS lvc_concept_rulings_concept_idx ON lvc_concept_rulings (concept_id, active);

-- the cache: a string is extracted once, ever
CREATE TABLE IF NOT EXISTS lvc_concept_strings (
  norm         TEXT PRIMARY KEY,               -- house-normalised finding subject
  concept_id   TEXT NOT NULL,
  context      TEXT,
  confidence   TEXT,                           -- seed ships low|medium|high
  source       TEXT NOT NULL DEFAULT 'extracted',  -- seed | extracted
  model        TEXT,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lvc_concept_strings_concept_idx ON lvc_concept_strings (concept_id);
CREATE INDEX IF NOT EXISTS lvc_concept_strings_source_idx  ON lvc_concept_strings (source);

-- resumable per-note watermark (mirrors even_ground_state)
CREATE TABLE IF NOT EXISTS even_concept_state (
  uid         TEXT PRIMARY KEY,
  coded_epoch BIGINT NOT NULL DEFAULT 0,
  coded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  n_stamped   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS even_concept_state_epoch_idx ON even_concept_state (coded_epoch);

-- tick log (observability; mirrors even_ground_ticks)
CREATE TABLE IF NOT EXISTS even_concept_ticks (
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL,
  processed   INT DEFAULT 0,
  stamped     INT DEFAULT 0,
  extracted   INT DEFAULT 0,
  rejected    INT DEFAULT 0,
  epoch       BIGINT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS even_concept_ticks_ts_idx ON even_concept_ticks (ts DESC);
