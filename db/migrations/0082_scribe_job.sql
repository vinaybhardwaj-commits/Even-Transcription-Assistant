-- =====================================================================
-- Migration 0082 — Tier 2 Slice B: the job table.
--
-- WHY (ETA Tier 2 spec v1.0, 12 September 2026, §3, ruling D2). The operator door can only answer
-- what fits inside one request. A read tool has 55 s and an invoke tool 115 s, and the Mini's real
-- work — transcribe a range, stitch an hour, measure a day — routinely outlasts both. Today that is
-- a tool that times out and a caller who cannot tell a slow answer from a lost one. A job is the
-- alternative: submit in under two seconds, get an id, and ask about it.
--
-- ONE STEP PER CLAIM IS THE WHOLE DESIGN. A serverless route has a hard ceiling (300 s here), so a
-- runner that tried to finish a job would be killed mid-flight and leave it half-done with nothing
-- written down. Instead every kind is a STEP MACHINE: the runner claims a job, runs exactly one
-- step, persists `step` and `progress`, and releases it. Steps are bounded at ~200 s by
-- construction, so the ceiling is never reached and a killed runner loses at most one step —
-- the next claim resumes from the step the row already names.
--
-- THE LEASE IS WHAT MAKES THAT SAFE. `lease_until` is set 240 s ahead when a job is claimed. A
-- runner that dies leaves the lease to expire, and the job becomes claimable again; a runner that
-- lives renews it by finishing its step. Claiming is `FOR UPDATE SKIP LOCKED`, so two runners on the
-- same minute take disjoint sets rather than blocking on each other or double-running a step.
--
-- TWO COUNTERS, AND CONFLATING THEM WAS A BUG. `attempts` counts CLAIMS — how many times a runner
-- has picked this row up — and a healthy multi-step job raises it once per step by construction: a
-- 61-minute stitch is one resolve plus three joins, so four claims, entirely successfully. Bounding
-- repair on `attempts` would therefore FAIL EVERY JOB LONGER THAN THREE STEPS, which is precisely
-- the work jobs exist for. `failures` counts only steps that THREW, and it is the one the cap reads.
-- A job that fails four times is not a transient fault and grinding it against the same error costs
-- the Mini real work — the R3 self-update loop (Fix 2, G1) is the house precedent for bounding a
-- retry with a counter on disk rather than hoping.
--
-- NOTHING HERE IS WIRED TO AUDIO YET. The table is the contract; Slices C and D fill in the kinds.
-- =====================================================================

CREATE TABLE IF NOT EXISTS scribe_job (
  -- `job_…`, minted by the submitter. Text, like every other id in this schema.
  id             text PRIMARY KEY,
  -- Which step machine runs this row (lib/jobs/kinds/*.ts). NOT a CHECK: a kind added by a later
  -- slice must not need a migration, and an unknown kind is refused at submit by the registry,
  -- which is the place that can name the allowed list in its error.
  kind           text        NOT NULL,
  args           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The five states a job can be in. CHECKed, because these ARE the contract every reader relies on.
  status         text        NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  -- Where the machine is. NULL = not started; the next claim runs the kind's first step.
  step           text,
  -- What the step wants to hand its successor, and what a watcher reads. Never audio, never text.
  progress       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result         jsonb,
  error          text,
  -- Who submitted it: the resolved MCP actor (Tier 2 §2.3), so a job is attributable.
  actor          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  -- Held by the runner that is working this row. Past = claimable again, whatever `status` says.
  lease_until    timestamptz,
  -- How many times a runner has CLAIMED this row. Rises once per step on a healthy job; it is a
  -- progress measure and a liveness signal, NOT a retry budget.
  attempts       integer     NOT NULL DEFAULT 0,
  -- How many steps have THROWN. The cap reads this and only this.
  failures       integer     NOT NULL DEFAULT 0
);

-- The claim query's index: "the oldest queued or expired-lease job". Both columns, in that order,
-- because status is the selective half and created_at is the order the claim takes them in.
CREATE INDEX IF NOT EXISTS scribe_job_status_created_idx ON scribe_job (status, created_at);

COMMENT ON TABLE scribe_job IS
  'Tier 2 §3 (D2). Long operator work as jobs: submit returns an id in under two seconds and the runner advances the row one step per claim. Steps are bounded so a serverless ceiling is never reached; lease_until + FOR UPDATE SKIP LOCKED keep two runners from working the same row.';

COMMENT ON COLUMN scribe_job.step IS
  'Where the kind''s step machine has reached. NULL means not started. Persisted after EVERY step, so a runner killed mid-flight resumes at the step this names rather than restarting the job.';

COMMENT ON COLUMN scribe_job.progress IS
  'What one step hands the next, and what a watcher reads. Ids, counts, keys and timings only — never audio bytes, never transcript text.';

COMMENT ON COLUMN scribe_job.lease_until IS
  'Set 240 s ahead when claimed. A runner that dies lets it expire and the job becomes claimable again; this is the only thing that distinguishes "being worked" from "abandoned".';

COMMENT ON COLUMN scribe_job.attempts IS
  'Incremented on every CLAIM. A healthy multi-step job raises it once per step — a 61-minute stitch is four claims and four successes — so this is progress and liveness, never a retry budget. The cap does not read it.';

COMMENT ON COLUMN scribe_job.failures IS
  'Incremented only when a step THREW. Above three the job is failed rather than retried for ever. Bounding on attempts instead would fail every job longer than three steps, which is the work jobs exist for.';

INSERT INTO schema_migrations (version, name)
VALUES (82, '0082_scribe_job')
ON CONFLICT DO NOTHING;
