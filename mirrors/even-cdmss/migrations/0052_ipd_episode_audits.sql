-- 0052_ipd_episode_audits — the IPD EPISODE audit's three tables (engine `ipd-episode-audit/0.1`,
-- PRD §7). ADDITIVE IN FULL: no existing table is altered and nothing here touches
-- ipd_discharge_audits, which this engine only ever READS (its score is shown beside this one,
-- labelled as the discharge engine's, per decision 14).
--
-- WHY NEW TABLES RATHER THAN COLUMNS ON ipd_discharge_audits (decision 9): the two engines answer
-- different questions on different keys. The discharge engine grades one document keyed on
-- document_id; this one grades a whole admission keyed on encounter_id, and carries a per-day
-- checkpoint child table the other has no use for.
--
-- PHI POSTURE — OMISSION, NOT HASHING (decision 23). These tables carry encounter_id, ip_uid and
-- member_id as re-identification keys and nothing else that could name a person. There is no
-- uhid column, no patient name, no age, no gender, no birth date, no mobile and no address, and
-- there is no hash of any of them: the repo has never hashed an identifier and a hash of a small
-- identifier space is not de-identification. Names are joined at RENDER time from db13 by the
-- existing namesForIpUids path and are never written here.

CREATE TABLE IF NOT EXISTS ipd_episode_audits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audited_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source            TEXT NOT NULL DEFAULT 'standalone',

  engine_version        TEXT NOT NULL,

  -- EVERY RUN IS KEPT (V, 2026-09-02). The upsert this replaces overwrote an episode's previous
  -- row, so two runs of the same episode could never be compared — which is the only way a
  -- reproducibility problem becomes visible. run_seq orders the runs; is_current marks the one
  -- every reader uses.
  run_seq               INTEGER NOT NULL DEFAULT 1,
  is_current            BOOLEAN NOT NULL DEFAULT TRUE,

  -- link-back keys (re-identification path into db13; never sent to a model)
  encounter_id          TEXT NOT NULL,
  ip_uid                TEXT NOT NULL,
  member_id             TEXT,

  facility_name         TEXT,
  speciality            TEXT,
  admitted_at           TIMESTAMPTZ,
  discharged_at         TIMESTAMPTZ,
  los_days              INTEGER,
  discharge_type        TEXT,
  extraction_version    TEXT,

  -- headline
  --
  -- DEFAULT 0 ON EVERY COUNTED COLUMN, and the reason is that NULL and 0 are different claims.
  -- "no divergent findings" is a result; "we do not know how many divergent findings there were"
  -- is an absence. A nullable counter makes SUM() and AVG() silently skip rows, so a cohort with
  -- one unwritten column reports a mean over a denominator nobody chose. The writer also coalesces
  -- (lib/ipd-episode/store.ts) — the default is the backstop for a future column added to the DDL
  -- and not yet to the INSERT, which is exactly how a null gets in.
  -- ⚠️ NO DEFAULT ON divergence_index, unlike every other counted column. This one may legitimately
  -- be NULL, and that is the whole point of scoring_status below: an episode where no checkpoint
  -- produced an expectation has no score, and 0 would read as catastrophic while 100 — what the
  -- arithmetic actually yields — reads as flawless. Null is the only honest value.
  divergence_index      INTEGER,
  -- 'ok' | 'no_expectations' | 'all_capped'. Anything but 'ok' means the number beside it is not a
  -- score and no surface may render it as one.
  -- THE REPORTED FIGURE. The index above is internal: it has a MEASURED ±5 repeat-run spread on
  -- identical input (IP-1286, five runs at 40/37/36/41/36 on sha 334ed090), so showing a number
  -- implies a precision this engine does not have. Deliberately NOT the discharge engine's A–E
  -- letters, which appear on the same screen meaning something else.
  divergence_band       TEXT,
  -- The index is within 5 points of a band threshold, so a re-run could land it either side.
  band_uncertain        BOOLEAN DEFAULT FALSE,
  scoring_status        TEXT NOT NULL DEFAULT 'ok',
  completeness_pct      INTEGER DEFAULT 0,

  -- counters (§6.1) — one column per counter
  n_findings            INTEGER DEFAULT 0,
  n_divergence_pass     INTEGER DEFAULT 0,
  n_fidelity_pass       INTEGER DEFAULT 0,
  n_omission            INTEGER DEFAULT 0,
  n_commission          INTEGER DEFAULT 0,
  n_timing              INTEGER DEFAULT 0,
  n_sequencing          INTEGER DEFAULT 0,
  n_divergent           INTEGER DEFAULT 0,
  n_context_dependent   INTEGER DEFAULT 0,
  n_unassessable        INTEGER DEFAULT 0,
  n_concordant          INTEGER DEFAULT 0,
  n_low_value           INTEGER DEFAULT 0,
  -- EVERY discarded finding: A2 domain drops plus parse failures. n_parse_failed breaks out the
  -- second cause. Both exist because an episode once lost 5 of 15 divergence findings with every
  -- counter reading 0 — a discard that leaves no number anywhere is indistinguishable from a clean
  -- run, and it was only found by reading a trace.
  n_dropped_invalid     INTEGER DEFAULT 0,
  n_parse_failed        INTEGER DEFAULT 0,
  -- decision 33: unassessable verdicts the postcondition rejected, and omission findings
  -- the diff pass emitted after code took ownership of omissions.
  n_unassessable_rejected INTEGER DEFAULT 0,
  n_judged_omissions_dropped INTEGER DEFAULT 0,
  n_findings_truncated  INTEGER DEFAULT 0,
  -- ROUND 12 ITEM 2. Both halves of the grouping, always: how many resolver findings
  -- are PRESENTED, and how many expected-course entries they stand for. One without
  -- the other either hides the collapse or describes an episode nobody is shown.
  n_resolver_grouped    INTEGER DEFAULT 0,
  n_resolver_ungrouped  INTEGER DEFAULT 0,
  judge_temperature     DOUBLE PRECISION,
  resolution_counts     JSONB,

  -- How many findings any cap touched. Recountable from findings[].capped / verdict_before_cap —
  -- the point being that "5 capped" is now a number in the row rather than a sentence in a
  -- response body that nobody can check.
  capped_count          INTEGER DEFAULT 0,
  -- Which checkpoints were run, and how. 'standard' is every day boundary plus the episode.
  checkpoint_policy     TEXT DEFAULT 'standard',
  checkpoint_concurrency INTEGER,
  checkpoint_wall_ms    INTEGER,
  -- Events the PROMPTS carried vs what assembly produced. IPNO-416 timed out because every
  -- checkpoint re-rendered 269 billing lines; the ratio makes that visible before it is a failure.
  prompt_events         INTEGER,
  assembled_events      INTEGER,
  -- ROUND 13 ITEM 3. The diff pass used to be sent every expected course in full; it is now sent a
  -- deduplicated digest of item text (decision 33 left it judging commission, timing and
  -- sequencing, none of which need the matchers, rationales or severities). Both numbers are
  -- stored because either alone is unreadable: chars without entries cannot say whether a smaller
  -- prompt came from the digest or from a quieter episode.
  diff_prompt_chars     INTEGER,
  digest_entries        INTEGER,
  -- ROUND 15 ITEM 1. divergence_index is a RATE now — penalty over the worst this episode could
  -- have scored — so the absolute figures must be stored beside it or they are gone. IP-1483
  -- (penalty 113) and IPNO-495 (penalty 198) both floored at 0 under the old total and read as the
  -- same episode. The rate bands it; these two say how much there is to read.
  penalty_total         INTEGER DEFAULT 0,
  expectations_evaluated INTEGER DEFAULT 0,
  -- Per-stage wall times. Without these, "which stage is superlinear" is a guess.
  stage_timings         JSONB,
  checkpoint_count      INTEGER DEFAULT 0,
  evidence_tiers        JSONB,
  real_course           JSONB,
  findings              JSONB,
  -- ROUND 12 / DECISION 35. Commentary is generated ON DEMAND now, the first time an episode's
  -- detail page is opened, so pass B runs long after the pipeline has exited and cannot rebuild
  -- its own inputs from memory. Everything else it needs is already on this row or on the
  -- checkpoint rows; the admission context was the one input built during assembly and never
  -- persisted. NULL commentary is a normal, complete, scorable episode — never a failure.
  admission_context     TEXT,
  commentary            JSONB,

  model_checkpoint      TEXT,
  model_judge           TEXT,
  trace_id              TEXT,
  -- ⚠️ `de_identified` WAS HERE AND IS GONE (round 17 item 5). It was an assertion column that
  -- asserted nothing: DEFAULT TRUE, never written by the pipeline, therefore TRUE on every row
  -- whatever ran. Worse, it was TRUE throughout the period when `real_course` was carrying a
  -- theatre assistant's name in an OT note (round 14 item 9) — so the one thing it claimed was the
  -- one thing that was not true. A column that can only ever agree with itself invites a
  -- confidence nobody has checked, which is the same failure `scoring_status` exists to prevent.
  -- De-identification is enforced where it happens: the Deidentifier in assembly, the column
  -- allow-lists in db13.ts, `isPersonFieldName`, and the source-read tests that hold all three.

  -- Whatever went wrong on an episode that still produced a row, in prose: findings repaired,
  -- findings discarded, a rejected commentary, an entirely uncited expected course.
  error_detail          TEXT,

  -- The evidence behind error_detail: one entry per DISCARDED finding, carrying the raw fragment
  -- (truncated to 1000 chars) and the validation error that killed it, tagged with its pass. The
  -- counter says how many were lost; this says what they were.
  raw_judge_error       JSONB
);

-- One row per RUN, and exactly one current row per (encounter_id, engine_version). The partial
-- unique index is what makes "exactly one" a database guarantee rather than a convention the
-- writer is trusted to keep.
CREATE UNIQUE INDEX IF NOT EXISTS ipd_episode_audits_encounter_engine_run_uq
  ON ipd_episode_audits (encounter_id, engine_version, run_seq);
CREATE UNIQUE INDEX IF NOT EXISTS ipd_episode_audits_current_uq
  ON ipd_episode_audits (encounter_id, engine_version) WHERE is_current;
CREATE INDEX IF NOT EXISTS ipd_episode_audits_discharged_idx ON ipd_episode_audits (discharged_at DESC);
CREATE INDEX IF NOT EXISTS ipd_episode_audits_speciality_idx ON ipd_episode_audits (speciality);
CREATE INDEX IF NOT EXISTS ipd_episode_audits_ip_uid_idx     ON ipd_episode_audits (ip_uid);

-- One row per checkpoint. `input_cutoff_at` and `input_event_count` are THE BLINDING PROOF: the
-- orchestrator recomputes both from the stored real_course and demands they agree with the day
-- boundary and the count of events before it (§14 step 8).
CREATE TABLE IF NOT EXISTS ipd_episode_checkpoints (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_audit_id   UUID REFERENCES ipd_episode_audits(id) ON DELETE CASCADE,
  day_index          INTEGER NOT NULL,
  checkpoint_type    TEXT NOT NULL,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_cutoff_at    TIMESTAMPTZ NOT NULL,
  input_event_count  INTEGER,
  retrieval_query    TEXT,
  retrieval_failed   BOOLEAN DEFAULT FALSE,
  -- INTEGER[], matching PRD §7.2 and the type of mksap_chunks.id, which is what these ARE
  -- (lib/ipd-episode/checkpoint-core.ts resolves the model's ordinals to real chunk ids before
  -- anything is stored). The store's INSERT casts $8::int[] and a contract test pins the two
  -- together: a mismatch here would be rejected by Postgres inside a catch, and every checkpoint
  -- row — which is where input_cutoff_at and input_event_count live, the blinding proof — would
  -- vanish without a sound.
  citation_ids       INTEGER[],
  expected_course    JSONB,
  status             TEXT,
  error_detail       TEXT,
  model              TEXT,
  trace_id           TEXT,

  -- Grounding, as SCALARS. An expected course whose every entry cites nothing is a failed
  -- checkpoint that looks successful — it has a status of 'ok', a real retrieval_query and eight
  -- real citation_ids on the row itself. These two columns make "how many entries did this
  -- checkpoint actually ground?" answerable across the cohort in one query, with no jsonb parsing.
  uncited_entry_count INTEGER DEFAULT 0,
  entry_count         INTEGER DEFAULT 0,

  -- Cited chunk id → the chunk's `source`, as a JSON object. Retrieval is no longer restricted to
  -- the normative allowlist (V, 2026-09-02): this engine may cite StatPearls, journal content,
  -- textbook passages. That is a gain in coverage and a change in what a citation MEANS, so the
  -- source is stored per citation and the normative/literature split is DERIVED from it rather
  -- than baked in — a later change to the normative source list can be re-applied to stored rows
  -- without re-running a single model call.
  citation_sources    JSONB,

  -- What actually came back, in a column. A topical failure — a hernia repair answered with
  -- paediatric rotation content — was invisible until someone opened the jsonb and read it.
  retrieved_titles    TEXT[],
  -- True when NO excerpt shared a clinical term with the query. Recorded, never blocking: the
  -- checkpoint still generates, and the uncited cap already bounds what a finding built on
  -- off-topic material may score.
  retrieval_offtopic  BOOLEAN DEFAULT FALSE,
  -- no retrieval was ATTEMPTED (empty query) — distinct from retrieval_failed, which means it
  -- was attempted and threw. A checkpoint generated with no evidence now says so.
  retrieval_skipped   BOOLEAN DEFAULT FALSE,
  -- How many of the k excerpts shared no clinical term with the query. The boolean fires on a
  -- MAJORITY; the count is what makes the boolean checkable. The all-or-nothing version could not
  -- fire and never did, while half a slate was unrelated.
  offtopic_excerpt_count INTEGER DEFAULT 0,
  -- The day 0 query was empty and fell back to the episode's OT surgery_name. That fallback reaches
  -- outside the cut-off window, so every row it touches says so and the frequency is measurable.
  day0_query_from_ot  BOOLEAN DEFAULT FALSE,

  -- What this checkpoint actually ran with. Temperature has been 0 since the first commit, so it
  -- does not explain the run-to-run variance; it is recorded so the next investigation does not
  -- have to take that on trust. `seed` is NULL by necessity: Bedrock's Converse inferenceConfig
  -- accepts maxTokens and temperature and nothing else, so AUDIT_LLM_SEED has no wire field here.
  temperature         DOUBLE PRECISION,
  seed                INTEGER,

  -- The token ceiling this checkpoint ran under, and what the provider said when it stopped.
  -- RECORDED ON EVERY ROW, not only on failure: `length` means the answer was truncated, and five
  -- consecutive runs lost their day-2 checkpoint to exactly that without it being visible anywhere
  -- except an error string. `attempts` is how many tries it took.
  max_tokens          INTEGER,
  finish_reason       TEXT,
  attempts            INTEGER DEFAULT 0,
  -- Entries dropped by the per-category cap, so a cap biting too hard is visible in the data.
  entries_truncated   INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ipd_episode_checkpoints_audit_idx ON ipd_episode_checkpoints (episode_audit_id);

-- Skips are a RECORD, not an absence: "we looked and this episode does not qualify" is a finding.
-- Retried each tick until 14 days after discharge, then left alone (§3.1).
CREATE TABLE IF NOT EXISTS ipd_episode_skips (
  encounter_id    TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts        INTEGER NOT NULL DEFAULT 1,
  discharged_at   TIMESTAMPTZ,

  -- ⚠️ THE DIAGNOSIS LIVES WITH THE FAILURE (round 11 item 4). Stage timings, the checkpoint
  -- summary and the prompt/assembled event counts used to be written ONLY on the audit row — so
  -- they existed for every run that succeeded and none that failed. IPNO-416 failed twice and left
  -- nothing but a wall-clock reading taken outside the process.
  diagnostics     JSONB,
  detail          TEXT,
  PRIMARY KEY (encounter_id, engine_version)
);

CREATE INDEX IF NOT EXISTS ipd_episode_skips_discharged_idx ON ipd_episode_skips (discharged_at DESC);
