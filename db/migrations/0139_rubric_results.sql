-- =====================================================================
-- Migration 0139 — S7-0: rubric run and result tables.
--
-- WHY. A rubric (rubrics/<id>/rubric.json, a versioned repo file) runs over stored data and must leave a record that says WHICH rubric version scored WHICH unit, when,
-- and how it went, without copying any patient text. rubric_run is one execution (a run over units, or a bench run); rubric_result is one unit's outcome.
-- The per-unit evidence JSON lives in R2 (eta-lab-results rubric/<rubric_id>/<version>/<unit_key>.json), not here.
--
-- NO TRANSCRIPT TEXT in either table: score is numbers and enums, findings is a list of closed codes. unit_key is an id (a window id, a consult key, room:date:hour), never a name.
-- `lab` separates results of a non-production rubric (or an explicit lab run) from production ones: the same unit can hold one of each (UNIQUE includes lab).
-- App-owned, no role grants (the app owns what it creates, as 0135 and 0136). Additive and idempotent: applies twice.
-- =====================================================================

CREATE TABLE IF NOT EXISTS rubric_run (
  run_id         text        PRIMARY KEY,
  rubric_id      text        NOT NULL CHECK (rubric_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  version        text        NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  kind           text        NOT NULL CHECK (kind IN ('run', 'bench')),
  units_planned  integer     NOT NULL DEFAULT 0 CHECK (units_planned >= 0),
  units_ok       integer     NOT NULL DEFAULT 0 CHECK (units_ok >= 0),
  units_failed   integer     NOT NULL DEFAULT 0 CHECK (units_failed >= 0),
  cost_usd       numeric(12, 5) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  actor          text,
  CONSTRAINT rubric_run_finish_chk CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS rubric_run_rubric_idx ON rubric_run (rubric_id, version, started_at DESC);

CREATE TABLE IF NOT EXISTS rubric_result (
  rubric_id   text        NOT NULL CHECK (rubric_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  version     text        NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  unit_kind   text        NOT NULL CHECK (unit_kind IN ('window', 'consult', 'room_hour', 'stay')),
  unit_key    text        NOT NULL CHECK (char_length(unit_key) BETWEEN 1 AND 200),
  room_id     text,
  ist_date    date,
  run_id      text        NOT NULL REFERENCES rubric_run (run_id),
  status      text        NOT NULL CHECK (status IN ('ok', 'empty', 'skipped', 'failed')),
  score       jsonb,
  findings    jsonb,
  lab         boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rubric_result_score_chk CHECK (score IS NULL OR jsonb_typeof(score) = 'object'),
  CONSTRAINT rubric_result_findings_chk CHECK (findings IS NULL OR jsonb_typeof(findings) = 'array'),
  CONSTRAINT rubric_result_uq UNIQUE (rubric_id, version, unit_key, lab)
);
CREATE INDEX IF NOT EXISTS rubric_result_room_date_idx ON rubric_result (rubric_id, room_id, ist_date);
CREATE INDEX IF NOT EXISTS rubric_result_run_idx ON rubric_result (run_id);
CREATE INDEX IF NOT EXISTS rubric_result_unit_idx ON rubric_result (rubric_id, unit_kind, created_at DESC);

COMMENT ON TABLE rubric_run IS 'S7-0: one execution of a rubric over units (kind run) or over its bench set (kind bench). Counts and cost only.';
COMMENT ON TABLE rubric_result IS 'S7-0: one unit''s outcome under one rubric version. score = numbers and enums, findings = closed codes; NO transcript text. Evidence JSON is in R2 rubric/<rubric_id>/<version>/<unit_key>.json.';
COMMENT ON COLUMN rubric_result.lab IS 'true for a result of a non-production rubric or an explicit lab run; production results are lab=false. The same unit may hold one of each.';

INSERT INTO schema_migrations (version, name)
VALUES (139, '0139_rubric_results')
ON CONFLICT DO NOTHING;
