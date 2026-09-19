# ETA — Jev text-signal arm (Arm D) and text role signal — Build Spec v1.0

Date: 18 Sep 2026
Author: Fable (orchestrator), for a Sonnet Builder in Claude Code
Repo: `Even-Transcription-Assistant`, branch off `vinay/s1-auto-drain`
Status: SPEC, bench-only. Nothing in this spec writes to production visit state or changes live behaviour.

**AMENDED v1.1, 18 Sep 2026, by Fable, after measuring the input.** v1.0 assumed
`transcription_run.transcript_english` exists for bench windows. **It does not, on any window, ever.**
`lib/stt/room-drain.ts:1235` submits to the router with `translate: false`, so `asr.english` is NULL on
every insert (`room-drain.ts:1066`). The §5.2 fallback (`transcript_original` when `detected_language='en'`)
cannot fire either: `detected_language` is also NULL on every bench_window run, because the router never
reads a language code back (already noted in §10). Verified 18 Sep against production on
`bw_bxcb9drz_1789739100000_primary` (today) and `bw_6jwz5r79_1789290000000_primary` (13 Sep): both
`transcript_english: null`, `detected_language: null`, `transcript_original` populated and code-mixed.
**As written, Arm D would skip 100% of windows as `skipped:no_english` and emit nothing.**
v1.1 adds **Slice J0** to produce the input, and amends §5.2, §7, §9 and §11. Slice order is now
J0 → J1 → J2 → (voice thresholds) → J3 → (D1) → J4.

---

## 0. Read this first

**Goal.** Add a fourth fuse arm, `jev`, that reads each room window's English transcript and emits a probabilistic view of consultation phase, consult start, consult end, and clinician presence, and a per-cluster text role signal for diarized speakers. Both run as offline bench jobs and are scored against existing truth (kiosk `consult_mark` cues, warehouse `pstart`/`pulse_note` cues, admin speaker labels). No production wiring.

**Why.** Visit boundaries today come only from typed cues (`lib/brain/fuse/rules.ts`); nothing reads what was said. Confidences are constants (`rules.ts:71-78`: direct pstart 0.9, inferred 0.65, direct call 0.6, inferred call 0.45, mark-only 0.3). The 45-minute mark window (`LAST_MARK_WINDOW_MS`, `rules.ts:79-88`) is the only fallback closer. Silence gaps were tried and rejected because 73% of inter-turn gaps are zero (`rules.ts:456-462`). Roles for non-clinician speakers come from talk-time order on the Mini (`eta-diarize/server.py:200-243`) plus a two-hit first-person regex (`lib/diarize.ts:335-372`). Jev supplies the missing text-derived signal with calibrated probabilities that code can gate on.

**Hard gate D1 (V's decision, open).** Real consult transcripts may not be sent to TypeSafe until V has cleared vendor egress (DPA, zero-data-retention). Until then, Slices J1 to J3 are built and unit-tested against fixtures and a mock provider only. Slice J4 (the live bench on real room-days) runs only after D1 is cleared. Do not run J4 on your own initiative.

**AMENDED v1.2, 19 Sep 2026.** The **`even-jev` MCP is now installed and keyed on the Mini**
(`~/dev/even-jev-mcp`, `run.sh`, `~/.config/even-jev/key` — both verified present). §1's endpoint facts
still hold, but the Builder calls Jev **through that MCP**, not by writing an HTTP client, and **must not
add the SDK** (already forbidden in §9). See `ETA-JEV-INTEGRATION.md` for how Jev is used across the
programme.

**D1 IS NOW TWO DECISIONS. Read this before assuming you are unblocked.**
- **D1a — development-time use on non-PHI** (diff review, question-wording trials on invented fixtures):
  **OPEN, in force from 19 Sep.** The MCP being installed is V's act, and nothing patient-related crosses.
- **D1b — real consult transcripts to TypeSafe** (DPA, zero-data-retention): **D1b CLEARED 18 Sep 2026
  by V in Cowork (trial terms: no training, zero retention); J4 runs after J1–J3 refutation.**

**D1b is cleared, but J4 still waits on refutation.** V's clearance in Cowork on 18 Sep (trial terms: no
training on our data, zero data retention) covers the vendor-egress question; J1–J3 were always
fixture-and-mock work and are unblocked today. J4 runs only after J1–J3 pass refutation — this is a build
gate, not a data-governance one.

**Delegation contract.** Build exactly the scope below. Report in the format in §9, under the cap. Anything you could not verify is marked UNVERIFIED in your report.

---

## 1. Jev facts the design depends on (verified from docs.typesafe.ai, 18 Sep 2026)

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, JSON body `{ model: "jev-latest", state, questions }`. JS SDK `@typesafe-ai/sdk` (Node 20+), env `TYPESAFE_API_KEY`, `client.systemOne({ state, questions })`, helpers `choice()`, `score()`, `noul()`.
- Three primitives. `noul` returns `noul` (P(yes), 0 to 1). `choice` returns `choice`, `probabilities` (map), `confidence`. `score` returns `score` (probability-weighted mean over 2 to 10 ordered levels), `probabilities`, `legend`, `confidence`. Many questions may be asked in one call against one state (fan-out).
- Text only. State is a string, JSON object, or JSON array. No audio, no embeddings.
- Limits: 64k tokens per request, 32k for state plus the longest question. Rate limits 250k tokens/s, 1,200 requests/min. Price $42 per billion input tokens, output free.
- English-primary model. Use `transcription_run.transcript_english`, never `transcript_original`.
- Documented weaknesses (jev-1.13): reads the question literally; bad at counting, arithmetic and date/time comparison; accuracy drops with irrelevant state; not adversarially robust; **related answers are not guaranteed consistent** (start and end can both be high in one window). Therefore: no timestamps in state, only ordinal window labels; all time arithmetic, thresholds, and arbitration live in code.
- Errors: 401 auth, 422 validation, 429 rate limit, 529 overloaded. Exponential backoff on 429/529.

---

## 2. Extension points in the repo (verified, do not rediscover)

| Thing | Where | Note |
|---|---|---|
| Arms | `lib/brain/fuse/types.ts:70-71` `ARMS = ["rules","hybrid","flash"]`, `type Arm` | Add `"jev"` |
| Arm dispatch | `lib/mcp/tools/fuse.ts:106-111` `runArm(arm, cues): Promise<ArmResult>` | Add `runJevArm` branch |
| Cue read | `fuse.ts:35` `readCuesForFuse(roomDayId): Promise<FuseCue[]>` | reuse |
| Visit write | `fuse.ts:57` `writeVisits(roomDayId, arm, visits: DraftVisit[])`, ON CONFLICT DO NOTHING on `(arm, opened_by)` | reuse |
| Arm output | `types.ts:75-114` `DraftVisit`, `UnboundEvidence`, `ArmOutput = { visits, unbound }` | conform |
| `visit.arm` | no CHECK constraint (`db/migrations/0048_visit_arm.sql:16-18`) | no migration needed for a new arm |
| `visit.clinician_source` | CHECK IN `roster|voice|mark|operator|unknown` (`0056_visit_reality.sql`) | Arm D never sets a clinician; leave NULL |
| `visit.state` | CHECK `called|in_chair|at_diagnostics|ended|unknown` | Arm D emits `in_chair` or `unknown` only |
| Cues | `cue(id, room_day_id, type, payload jsonb, at, session_id, source, source_ref)`; type is an open set; machine types are blocked from MCP manual posting (`lib/mcp/tools/fuse.ts` blocklist, `brain.ts:334`) | Arm D does not write cues in v1.0 |
| Windows | `bench_window(id, session_id, room_day_id, start_ms, end_ms, state, ...)` (`0057`) | ordinal source |
| Window text | `transcription_run` rows with `subject_type='bench_window'`, `subject_id=<window id>`, columns `detected_language, transcript_original, transcript_english, metrics_json` (see `lib/stt/room-drain.ts:1026-1067`) | input to Arm D |
| Diarize output | `room_diarize_window(window_id, room_day_id, state, speakers_json, segments_json, ...)` (`0074`) | input to J3 |
| Turn to speaker binding | `room_turn_speaker(window_id, source_ref, speaker_idx, cluster_id, clinician_id, role CHECK NULL or 'clinician', match_confidence, no_role_reason)` (`0074`, `0085`) | do NOT widen the CHECK in this spec |
| Turn text | `cue.type='stt_turn'` payload | J3 joins on `source_ref` |
| Job kinds | `lib/jobs/kinds/index.ts` `JOB_KINDS`; `JobKind = { name, first, scope, parseArgs, ... }` (`lib/jobs/types.ts:112-117`); `submitJob({kind,args,actor,origin?,scopes?})` (`lib/jobs/submit.ts:48`) | register two kinds |
| Flags/env | `lib/env.ts` `env/envOptional/envBool`; `lib/flags.ts` `parseFlag`; per-room switches in `lib/room-switches.ts` (`visits_enabled`, `isVisitsEnabled`) | new env only, no new room switch |
| HTTP pattern | `lib/llm/gemini.ts:49-63`, `lib/sarvam.ts:58-66`: `AbortController` + `setTimeout` + optional caller `signal` | copy |
| LLM trace | `lib/llm-trace/log.ts:72` `openTrace({surface,...})`, `handle.event(...)`, `handle.finalise({status, model_calls:[{model, latency_ms, tokens_in, tokens_out}]})` | trace every Jev call with `surface: "jev"` |
| MCP tool shape | `lib/mcp/registry.ts` `McpTool { name, description, scope, inputSchema, handler }`, example `lib/mcp/tools/fuse.ts:115-129` | copy |
| Tests | `vitest.config.ts` includes `tests/unit/**/*.test.ts`; fuse tests in `tests/unit/fuse-arms.test.ts` with fake pg harness mocking `@/lib/brain/db`; run `npm test` | extend |

---

## 3. Scope

In scope: Slices **J0**, J1, J2, J3 (code + unit tests + fixtures), J4 (bench runner and report, executed only after D1).
Out of scope, do not build: production wiring of Arm D into `runLiveFuse` (`lib/brain/fuse/live.ts`); any change to `rules.ts`; any change to cosine thresholds or the diarize service; widening `room_turn_speaker.role` CHECK; per-room switches; UI; the "transcript garbage" Noul, STT-judge Score, NABH Noul, CDMSS passage Score (listed in §8 as follow-ups).

---

## 3A. Slice J0 — English window text (NEW in v1.1; J2 cannot run without it)

**Problem.** Arm D's declared input does not exist. See the amendment banner. Three ways out were weighed:

| option | what | verdict |
|---|---|---|
| A | flip `room-drain.ts:1235` to `translate: true` | **Not now.** It is the right end state but it is the wrong first move: it pays an Ollama call per non-English span on the Mini for **every window in every room**, in a drain that has been live for hours and is unmeasured, to serve an arm nobody has shown is worth wiring. It also backfills nothing — the ~450 h already recorded stay English-less. Revisit after J4. |
| B | derive English inside Arm D's own job, persist it | **CHOSEN.** Touches no existing pipeline file, stays inside §9's allowed list, backfills history, and pays only for the windows Arm D actually reads, once each. |
| C | send `transcript_original` to Jev as-is | **Not the primary path** — Jev is English-primary (§1) and these transcripts are code-mixed en/hi/mr. **But it is free**, so it runs in J4 as a control arm (`jev-native`) to measure what the translation step is actually buying. |

**New table `jev_window_text`** (migration, next free number after `jev_window_signal`):
```
window_id   text PRIMARY KEY REFERENCES bench_window(id)
room_day_id text NOT NULL
english     text                     -- NULL means "tried and produced nothing", not "not tried"
source      text NOT NULL CHECK (source IN ('run_english','native_en','translated','empty'))
char_count  int  NOT NULL
model       text                     -- NULL for run_english / native_en
latency_ms  int
created_at  timestamptz NOT NULL DEFAULT now()
```
Index on `(room_day_id)`.

**New job kind `jev-english`** (`lib/jobs/kinds/jev-english.ts`, scope `invoke`), args
`{ room_day_id: string; force?: boolean }`. Per window, in order:

1. `transcription_run.transcript_english` non-empty → store it, `source='run_english'`. (Costs nothing, and
   becomes the live path for free the day option A is taken.)
2. Else, decide "is this already English?" **from `metrics_json`, not from `detected_language`** — the column
   is NULL but the metrics are not. Verified present on real rows:
   `metrics_json.full_window_language` (`"english"`), `metrics_json.sarvam_language` (`"en"`), and
   `metrics_json.language_timeline.language_mix` (a per-span map, e.g. `{"en":2,"hi":1,"und":1}`).
   **Rule, all three must agree to skip translation:** `full_window_language == "english"` AND
   `sarvam_language` starts with `"en"` AND `language_mix` has no key other than `en`/`und`. Then store
   `transcript_original`, `source='native_en'`.
3. Else translate `transcript_original` through the Mini's existing local path (`lib/llm/` + the router's
   translate leg — **the Mini, never TypeSafe; D1 does not gate J0**), store, `source='translated'`, record
   `model` and `latency_ms`.
4. Empty or whitespace-only result → row with `english = NULL`, `source='empty'`. **A row is always written**,
   so "no English for this window" is an evidenced state and not an absence (D-11).

`ETA_JEV_TRANSLATE_ENABLED` gates step 3; unset → step 3 is skipped and those windows land as `source='empty'`.

**Tests** (`tests/unit/jev-english.test.ts`): the three-way agreement rule, including the real
`language_mix` shapes above and the mixed case that must translate; every branch writes a row; `force` re-runs;
an empty translation is `source='empty'` and not an exception.

---

## 4. Slice J1 — Jev provider client

**Files (new):** `lib/jev/client.ts`, `lib/jev/types.ts`, `lib/jev/mock.ts`, `tests/unit/jev-client.test.ts`.

**Env (add to `lib/env.ts` readers, document in `.env.example`):**
- `TYPESAFE_API_KEY` (secret)
- `ETA_JEV_ENABLED` (flag, default off; when off, `client.ts` throws `JevDisabledError` before any network call)
- `ETA_JEV_MODEL` default `jev-latest`
- `ETA_JEV_TIMEOUT_MS` default `15000`
- `ETA_JEV_MOCK` (flag, default off; when on, `getJevClient()` returns the mock)

**Interface (`lib/jev/types.ts`):**
```ts
export type JevNoulQ = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type JevChoiceQ<K extends string> = { type: "choice"; instructions: string; criteria: Record<K, string | null> };
export type JevScoreQ = { type: "score"; instructions: string; criteria: string[] }; // ordered low→high, 2..10
export type JevQuestion = JevNoulQ | JevChoiceQ<string> | JevScoreQ;
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number };
export type JevRequest = { state: unknown; questions: Record<string, JevQuestion>; model?: string };
export type JevResult = { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number }; latency_ms: number };
export interface JevClient { systemOne(req: JevRequest, opts?: { signal?: AbortSignal; trace?: TraceHandle }): Promise<JevResult>; }
```

**Behaviour:**
- Use raw `fetch` against `/v1/systemone` (do not add the SDK dependency in v1.0; the HTTP schema is small and the repo already has the fetch+abort pattern). Retry 429/529 with exponential backoff, max 3 attempts, jitter; never retry 401/422.
- Every call opens a trace with `openTrace({ surface: "jev", request_input: <question ids + state byte size, never the state text> })` and finalises with `model_calls:[{ model, latency_ms, tokens_in: usage.input_tokens, tokens_out: usage.output_tokens }]`.
- Estimate state size before sending: if `JSON.stringify(state).length > 100_000` characters (~25k tokens), throw `JevStateTooLargeError`; callers must chunk.
- Mock (`lib/jev/mock.ts`): deterministic answers from a fixture map keyed by question id, used in all unit tests and when `ETA_JEV_MOCK=1`.

**Tests:** request body shape for each primitive; 429 then 200 retries once; 422 does not retry; disabled flag throws before fetch; state-size guard; trace finalised with token counts.

---

## 5. Slice J2 — Arm D (`jev`): window signals → DraftVisits

### 5.1 Data

**New table `jev_window_signal`** (migration `db/migrations/00NN_jev_window_signal.sql`, next free number):
```
window_id text PK REFERENCES bench_window(id)
room_day_id text NOT NULL
session_id text NOT NULL
start_ms bigint NOT NULL, end_ms bigint NOT NULL
phase text NOT NULL CHECK (phase IN ('non_clinical','arrival','history','examination','plan','closing'))
phase_probs jsonb NOT NULL
phase_confidence real NOT NULL
p_start real NOT NULL      -- Noul: a new patient's consultation begins in this window
p_end real NOT NULL        -- Noul: the current consultation ends in this window
p_clinician real NOT NULL  -- Noul: the treating clinician is speaking in this window
p_clinical real NOT NULL   -- Noul: this window contains clinical conversation at all
model text NOT NULL, prompt_version text NOT NULL, input_tokens int NOT NULL
batch_id text NOT NULL     -- one Jev call
created_at timestamptz DEFAULT now()
```
Index on `(room_day_id, start_ms)`.

### 5.2 Job kind `jev-window` (`lib/jobs/kinds/jev-window.ts`, scope `invoke`)

Args: `{ room_day_id: string; prompt_version?: string; force?: boolean }`.

Steps:
1. **collect** (AMENDED v1.1): all `bench_window` rows for the room_day ordered by `start_ms`, joined to **`jev_window_text`** (J0), taking `english`. **Do not read `transcript_english` or `detected_language` here — both are NULL on every bench window; see the amendment banner.** A window with no `jev_window_text` row at all means J0 has not run for this room-day: **fail the job** with `jev_english_missing` rather than silently skipping, because "J0 was never run" and "there was nothing to translate" are different facts (D-10/D-11). A row with `english IS NULL` is a genuine skip: record `phase='non_clinical'`, all p_* = 0, `prompt_version='skipped:no_english'`. Skip windows already in `jev_window_signal` unless `force`.
2. **batch**: group consecutive windows into batches of up to `ETA_JEV_BATCH_WINDOWS` (default 20, i.e. 10 minutes at 30 s windows). Each batch carries `ETA_JEV_CONTEXT_WINDOWS` (default 2) preceding windows as read-only context.
3. **ask**: one Jev call per batch. State and questions per §5.3.
4. **persist**: one `jev_window_signal` row per target window (context windows are not persisted from this batch).
5. **finish**: summary `{ windows_total, windows_asked, windows_skipped, calls, input_tokens, est_cost_usd }` with `est_cost_usd = input_tokens * 42e-9`.

Concurrency: max 2 Jev calls in flight per job; global in-flight cap 4 (module-level semaphore, same pattern as `eta-router`).

### 5.3 State and questions (prompt_version `jev-arm-d-v1`)

State (JSON object, no timestamps, no room or doctor names, no patient identifiers beyond what the transcript itself contains):
```json
{
  "setting": "Outpatient consultation room in an Indian hospital. Transcript is machine-translated to English from Kannada, Hindi or English speech and may contain recognition errors. Windows are consecutive 30-second slices in order.",
  "context_windows": [ { "id": "C1", "text": "..." }, { "id": "C2", "text": "..." } ],
  "windows": [ { "id": "W1", "text": "..." }, { "id": "W2", "text": "..." }, ... ]
}
```
Questions, fanned out per target window `Wk` (four question ids per window: `phase_Wk`, `start_Wk`, `end_Wk`, `clinician_Wk`, plus `clinical_Wk`):

- `phase_Wk` (choice): instructions `"Which phase of a patient consultation does window Wk mainly show? Consider the surrounding windows for context but answer for Wk only."`; criteria
  - `non_clinical`: `"No patient consultation is happening: staff talking among themselves, phone calls, silence, noise, admin work, or unrelated chatter."`
  - `arrival`: `"A patient is arriving or being seated: greetings, names being confirmed, being asked to sit, small talk before any medical content."`
  - `history`: `"The patient or attendant is describing complaints, symptoms, duration, past illness, medicines, or the clinician is asking about them."`
  - `examination`: `"Physical examination is under way: instructions like breathe in, lie down, show me, or reading out findings and vitals."`
  - `plan`: `"The clinician is explaining the diagnosis, prescribing, ordering tests, or giving advice and instructions."`
  - `closing`: `"The consultation is ending: follow-up date, thanks, goodbyes, patient leaving, or the next patient being called."`
- `start_Wk` (noul): `"Does a new patient's consultation begin in window Wk, meaning a different patient from the one in the preceding windows starts being seen?"`; criteria `true: "A different patient's visit clearly starts here."`, `false: "Same patient continues, or no consultation is happening."`
- `end_Wk` (noul): `"Does the patient consultation that was in progress end in window Wk?"`; criteria `true: "The visit wraps up here: final instructions, goodbye, patient leaves."`, `false: "The visit continues after this window, or there was no visit."`
- `clinician_Wk` (noul): `"Is the treating doctor speaking in window Wk?"`; criteria `true: "A doctor is asking, examining, explaining or prescribing."`, `false: "Only patients, attendants, nurses or other staff speak, or nobody."`
- `clinical_Wk` (noul): `"Does window Wk contain any clinical conversation between a clinician and a patient or attendant?"`

The instruction strings above are the v1 prompt; store them in `lib/jev/prompts/arm-d-v1.ts` with `PROMPT_VERSION = "jev-arm-d-v1"`. Do not include worked examples in instructions (known leakage risk in this codebase).

### 5.4 Arm D (`lib/brain/fuse/jev-arm.ts`), `runJevArm(cues: FuseCue[], signals: JevWindowSignal[]): ArmOutput`

Pure function, no IO, like `rules.ts`. `runArm("jev", cues)` in `fuse.ts` loads `jev_window_signal` for the room_day, then calls it. If no signals exist, return `{ visits: [], unbound: [] }` and an `ArmFailure { ok:false, error:"no_jev_signals" }` at the dispatcher level, mirroring the X4 guard in `gemini-arms.ts:70-77`.

Algorithm (all thresholds env with defaults, read once at module load):
- `ETA_JEV_T_START` default 0.70, `ETA_JEV_T_END` default 0.70, `ETA_JEV_T_CLINICAL` default 0.60, `ETA_JEV_MIN_VISIT_WINDOWS` default 3, `ETA_JEV_MAX_GAP_WINDOWS` default 6 (3 minutes of non-clinical before a visit is closed).
- Walk windows in `start_ms` order.
  1. An **open** happens at window `Wk` when `p_start ≥ T_START`, or when no visit is open and `phase ∈ {arrival, history}` with `phase_confidence ≥ 0.6` and `p_clinical ≥ T_CLINICAL` for two consecutive windows (the second window's start opens the visit).
  2. A **close** happens when `p_end ≥ T_END`, or when a visit is open and `MAX_GAP_WINDOWS` consecutive windows have `p_clinical < T_CLINICAL`, or on the next open (B2-style precedence: explicit end > gap > next opener, evaluated at each window in that order).
  3. Visits shorter than `MIN_VISIT_WINDOWS` are dropped into `unbound` with reason `too_short`.
  4. **Inconsistency rule** (Jev does not guarantee coherence): if `p_start ≥ T_START` and `p_end ≥ T_END` in the same window, treat it as close-then-open (previous visit ends at `start_ms`, new one begins at `start_ms`) and set `reasons: ["jev_start_end_same_window"]`.
- Emit `DraftVisit`: `state: "in_chair"`, `pstart_at` = window `start_ms` mapped to the session's wall clock (use the same helper `rules.ts` uses for tape to wall time; if none exists, use `bench_window` joined session `started_at + start_ms`, UNVERIFIED which helper, report it), `ended_at` likewise, `confidence` = mean of the opening window's `p_start` (or phase probability that fired) and `p_clinical`, capped at 0.95, `opened_by: <window id>`, `opened_by_kind: "jev_window"`, `end_reason ∈ {"jev_end","jev_gap","next_opener","day_end"}`, `session_id`, `tape_start_ms`, `tape_end_ms`, `reasons` listing the firing rule and the p values, `clinician_id: null`, `clinician_source: null`, `clinician_confidence: null`.
- `individual_uid` and `consult_uid`: Arm D cannot know these. If a `consult_mark`, `pstart`, or `pqm_called` cue with an `individual_uid` falls inside `[tape_start_ms, tape_end_ms]`, adopt it and add reason `bound_to_cue:<cue id>`; otherwise leave null and set `state: "unknown"` only if `DraftVisit` requires a uid for `in_chair` (check `rules.ts` handling of mark-only visits and mirror it; report which).

`types.ts`: `ARMS = ["rules","hybrid","flash","jev"]`. Update `DEFAULT_ARM` untouched (`rules`). Confirm `fuse-report.ts` iterates `ARMS` generically; if it hard-codes three arms, extend it, do not fork it.

### 5.5 MCP tools

- `scribe_jev_window_run` (scope `invoke`): `{ room_day_id, force? }` → `submitJob({ kind: "jev-window", ... })`, returns job id.
- `scribe_fuse_run` already takes `arm`; ensure `"jev"` validates.
- `scribe_jev_signals` (scope `read`): `{ room_day_id, from_ms?, to_ms? }` → rows from `jev_window_signal`, no transcript text.

Register in the same tier/surface as `scribe_fuse_run` (operator door). Add to `docs/operator-mcp/` tool list.

### 5.6 Tests (`tests/unit/jev-arm.test.ts`, `tests/unit/jev-window-job.test.ts`)

Fixtures in `tests/fixtures/jev/`: (a) `day-clean.json`: 60 windows, three visits with clear start/end nouls; expect three `in_chair` visits with correct `tape_start_ms/end_ms`. (b) `day-gap.json`: a visit whose end never fires, closed by the gap rule after 6 non-clinical windows. (c) `day-inconsistent.json`: start and end both ≥ threshold in one window → close-then-open. (d) `day-short.json`: a 2-window blip → `unbound too_short`. (e) `day-bind.json`: a `consult_mark` cue inside a Jev visit → uid adopted, reason `bound_to_cue`. (f) job test: batching 45 windows into 20+20+5 with 2-window context, skipped windows persisted as `skipped:no_english`, state-size guard triggers chunk halving.
All Jev calls in tests go through the mock. `npm test` must pass; `npm run typecheck:tests` must pass.

---

## 6. Slice J3 — text role signal for diarized clusters

### 6.1 Data

**New table `jev_role_signal`**:
```
id text PK
window_id text NOT NULL REFERENCES bench_window(id)
room_day_id text NOT NULL
speaker_idx int NOT NULL
cluster_id text NULL
role text NOT NULL CHECK (role IN ('clinician','patient','attendant','nurse_or_staff','other'))
role_probs jsonb NOT NULL
role_confidence real NOT NULL
turn_count int NOT NULL, char_count int NOT NULL
model text, prompt_version text, input_tokens int, batch_id text
created_at timestamptz DEFAULT now()
UNIQUE (window_id, speaker_idx, prompt_version)
```
This table is bench-only and does not feed `room_turn_speaker` in v1.0.

### 6.2 Job kind `jev-role` (`lib/jobs/kinds/jev-role.ts`, scope `invoke`)

Args `{ room_day_id, prompt_version?, force? }`.
1. For each `room_diarize_window` with `state='ok'`, collect the window's `stt_turn` cues (payload text, English where available; document which payload key holds English text, UNVERIFIED until read) joined to `room_turn_speaker` on `source_ref` to get `speaker_idx`.
2. Group turns by `speaker_idx`. Skip speakers with `char_count < 40`.
3. State per window:
```json
{ "setting": "<same as §5.3>", "speakers": [ { "id": "S0", "turns": ["...","..."] }, { "id": "S1", "turns": ["..."] } ] }
```
Questions per speaker `role_Sk` (choice): `"What is speaker Sk's role in this consultation, judged only from what they say?"`; criteria `clinician: "Asks about symptoms, examines, explains diagnosis, prescribes, gives medical advice."`, `patient: "Describes their own symptoms, answers questions about their own body and history."`, `attendant: "A relative or companion speaking about the patient in the third person, or helping the patient answer."`, `nurse_or_staff: "Handles vitals, files, tokens, calling patients, room logistics, or talks to the doctor about other patients."`, `other: "Cannot be determined from these lines, or none of the above."`
4. Persist one row per speaker.

Concurrency and cost accounting as in J2.

### 6.3 Composite (bench-side only, `lib/jev/role-composite.ts`)

Pure function `compositeRole(text: JevRoleSignal, acoustic: { clinician_id: string | null; match_confidence: number | null })`:
- If `acoustic.clinician_id` is set (cosine matched a voiceprint): result `clinician` with `clinician_id` from acoustic; record `agree = text.role === "clinician"` for the bench.
- Else: result is `text.role` if `role_confidence ≥ ETA_JEV_T_ROLE` (default 0.6), otherwise `null` with reason `low_confidence`.
- Never assign a `clinician_id` from text. Text can say "clinician", it cannot say which one.

### 6.4 Tests (`tests/unit/jev-role.test.ts`)

Grouping by speaker, char floor, composite precedence (acoustic wins), low-confidence null, one persisted row per speaker.

---

## 7. Slice J4 — bench (runs only after D1 is cleared)

**Runner:** `scripts/jev-bench.ts` (ts-node/tsx like `scripts/load-warehouse-fixture.ts`), args `--room-days <ids csv | file>`, `--arms rules,hybrid,flash,jev`, `--out docs/handoff/scratch/jev-bench-<date>.json`.

**Dataset (AMENDED v1.1, measured 18 Sep):** the whole corpus today is **37 `consult_mark` cues across 17 room-days**, against **48 room-days carrying audio** (5,414 chunks, roughly 450 h). So the ≥10 room-day gate is met on paper and the *truth* set is not: ~37 positives. Also run `jev-english` (J0) over the chosen days first — `bench_window` coverage is necessary but no longer sufficient. Prefer days across at least three clinicians and at least two rooms. Exclude `room_day.scratch = true`.

**Truth:**
- Visit opens: `consult_mark` cue `at` (kiosk) and, where present, warehouse `pstart`. Visit closes: `pulse_note` where present, else the next `consult_mark`.
- Roles: `room_turn_speaker.role='clinician'` rows are truth for clinician; for non-clinician roles, an admin-labelled set of at least 60 speaker-windows is needed (V or an admin labels via a CSV in `docs/handoff/scratch/jev-role-labels.csv`: `window_id,speaker_idx,role`). If no labels exist, report role agreement only against the acoustic clinician flag and mark role accuracy UNVERIFIED.

**Metrics per arm (write all to the JSON and a markdown table):**
- Open recall and precision at ±180 s of a truth open; median and p90 absolute open error in seconds; same for closes where truth exists.
- Visit count per day vs truth count.
- Calibration of `p_start` and `p_end`: reliability table in 10 bins and ECE, computed on windows within ±60 s of a truth open/close (positives) versus all others (negatives).
- Role: accuracy and per-class confusion on the labelled set; agreement rate with the acoustic clinician flag; share of speakers left `null` by the composite.
- Cost: total input tokens and USD per room-day; median and p90 Jev latency.

**Acceptance (AMENDED v1.1).** The thresholds stand as targets — open recall ≥ 0.80 and precision ≥ 0.80 at ±180 s; median open error ≤ 90 s; ECE ≤ 0.10 on `p_start`; role accuracy ≥ 0.85 on labelled non-clinician speakers; cost ≤ $0.05 per room-day — **but on ~37 truth opens a recall estimate carries a 95% interval of roughly ±0.13, so the first run cannot accept or reject against them.** Therefore: report every metric **with its 95% confidence interval and its denominator**, never a bare point estimate; treat run 1 as **directional only**; hold the wire-it-in/drop-it verdict until **≥100 truth opens** exist. Run the `jev-native` control arm (J0 option C) alongside, so the cost of the translation step is measured and not assumed. Also report whether Arm D beats Arm A on open recall on the same days; if it does not, say so plainly.

---

## 8. Not in this spec, listed so nobody builds them by accident

- Replacing the regex hallucination blocklist (`lib/transcript-guard.ts`) with a Noul.
- Replacing the qwen 1–10 STT judge (`lib/stt/scoring.ts:126-176`) with a Score.
- NABH coverage Noul per field (`lib/notegen/coverage.ts`).
- CDMSS passage relevance Score (`lib/cdmss-pipeline.ts:340-380`).
- Any change to voiceprint matching, cosine thresholds, the EER or calibration routes, or `eta-diarize/server.py`.
- Language identification, silence floors, timing: Jev is the wrong tool.

---

## 9. Builder contract

**Allowed changes:** new files under `lib/jev/`, `lib/brain/fuse/jev-arm.ts`, `lib/jobs/kinds/jev-english.ts`, `lib/jobs/kinds/jev-window.ts`, `lib/jobs/kinds/jev-role.ts`, `lib/mcp/tools/jev.ts`, one migration per new table (J0 adds `jev_window_text`; two migrations total), `tests/unit/jev-*.test.ts`, `tests/fixtures/jev/`, `scripts/jev-bench.ts`, and minimal edits to `lib/brain/fuse/types.ts` (ARMS), `lib/mcp/tools/fuse.ts` (dispatch), `lib/jobs/kinds/index.ts` (registration), `lib/mcp/registry.ts` or wherever tools are listed, `.env.example`, `docs/operator-mcp/`.
**Forbidden:** `rules.ts`, `live.ts`, `gemini-arms.ts` logic, **`room-drain.ts` (still forbidden in v1.1 — option A is deliberately deferred until after J4; do not "fix" the English gap by editing the drain)**, `speaker-roles.ts`, any diarize or STT adapter, any existing migration, any CHECK constraint, any `NEXT_PUBLIC_*` flag, any UI.
**Verify before reporting:** `npm test` green; `npm run typecheck:tests` green; migration applies on a scratch DB and rolls forward from the current head; `ETA_JEV_ENABLED` unset → no network call is possible (prove with a test that asserts fetch is never invoked); a dry run of `jev-window` with `ETA_JEV_MOCK=1` on a fixture room-day produces `jev_window_signal` rows and `scribe_fuse_run` with `arm=jev` writes visits with `arm='jev'`.
**Do not:** run against real room-days or a real API key (D1); change thresholds outside env defaults; add the SDK dependency; put transcript text into traces or logs; touch anything under §8.
**Report format (cap 400 words plus the file list):** commit SHA on a branch `vinay/jev-arm-d`; files added and changed; test count before and after; the migration number used; any place this spec was wrong or underspecified, with what you did instead and why; every UNVERIFIED item; the exact commands to run the bench once D1 clears. Large logs go to `docs/handoff/scratch/jev-build-<date>.log`, not into the report.

---

## 10. Known facts and gotchas

- Whisper is nondeterministic at temperature 0 on about 40% of windows (`docs/handoff/ETA-W3-NOISE-FLOOR-14-SEP-2026.md`); Jev signals inherit that noise. Do not tune thresholds on a single run.
- The router's `whisper_infer` never reads back a language code (`ETA-W1-WHISPER-LANGUAGE-14-SEP-2026.md`); do not rely on `detected_language` for anything except the English fallback in §5.2 step 1.
- `encounter` and `visit` are separate models joined at read time (`lib/bench-join.ts`); Arm D works on `visit` only.
- Concrete worked examples inside system prompts get copied verbatim by models in this codebase; keep the criteria descriptive, no examples.
- The 19-Aug incident put attribution per visit, not per room-day (`0056_visit_reality.sql:16-22`); Arm D must never write a clinician.
- Cost sanity: a 30 s English window is roughly 110 tokens; a 20-window batch with instructions is roughly 4k tokens; an 8-hour room-day is roughly 50 calls and 200k tokens, about $0.01.

## 11. Open decisions for V

- **D1b: vendor egress of real consult transcripts to TypeSafe (DPA, ZDR). D1b CLEARED 18 Sep 2026 by V
  in Cowork (trial terms: no training, zero retention); J4 runs after J1–J3 pass refutation.** (D1a,
  development-time use on non-PHI, is in force from 19 Sep — the `even-jev` MCP is installed and keyed.
  See the v1.2 banner and `ETA-JEV-INTEGRATION.md`.)
  J0–J3 need nothing from TypeSafe and are unaffected either way. Note that J0 translation runs **on the
  Mini**, so nothing left the estate before D1b was answered.
- D3: who labels the 60 non-clinician speaker-windows for the role bench. V's call (it is somebody's hours).
- **D4 (new, v1.1, decided by Fable, recorded for V to overturn):** J0 option B over option A — derive English
  in Arm D's own job rather than flipping the production drain to `translate: true`. Reason in §3A. If V
  wants the drain flipped now instead, say so and J0 shrinks to step 1 plus a backfill for history.
