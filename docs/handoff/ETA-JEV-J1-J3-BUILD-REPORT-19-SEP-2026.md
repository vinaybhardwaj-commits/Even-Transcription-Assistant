# ETA — J1/J2/J3 build report (Arm D: text-signal fuse arm, jev client, role signal)

Date: 19 Sep 2026
Scope: `docs/handoff/ETA-JEV-ARM-D-SPEC-v1.0-18-SEP-2026.md` §4 (J1), §5 (J2), §6 (J3), §9 allowed changes.
Worktree: `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-jev1`, branch `vinay/jev-arm-d` (based on `vinay/s1-auto-drain`).
**J4 (the live bench runner) was NOT built and NOT run.** Nothing here touched a real room-day or the real Jev API — every test goes through `lib/jev/mock.ts`.

## What was built

**J1 — the jev client (`lib/jev/`)**
- `lib/jev/types.ts` — wire contract types for `jev_ask`/`jev_review` questions and answers (`noul`, `choice`, `score`).
- `lib/jev/client.ts` — `createHttpJevClient()` / `getJevClient()`, fetch+AbortController+timeout in the shape of `lib/llm/gemini.ts`, gated by `ETA_JEV_ENABLED` (parsed through `lib/flags.ts`'s `parseFlag()`, so an unset/unrecognized value never silently reads as on), with retry on 429/422, a state-size guard, and an `openTrace`/`TraceHandle` forensic trace (metadata only, never transcript text). `_resetJevClientForTests()` for isolation.
- `lib/jev/mock.ts` — `setMockJevAnswers()` / `getMockJevClient()`, swapped in via `ETA_JEV_MOCK=1`. Every test in this build drives the mock; none reach `fetch`.
- `tests/unit/jev-client.test.ts` (6 tests) — proves `ETA_JEV_ENABLED` unset cannot reach `fetch`, request shape, 429/422 retry, the state-size guard, and the trace.

**J2 — the `jev_window` job and Arm D fuse arm**
- `db/migrations/0106_jev_window_signal.sql` — additive, `IF NOT EXISTS`, self-recording.
- `lib/jev/prompts/arm-d-v1.ts` — the phase/p_start/p_end/p_clinician/p_clinical question wording, shipped as the spec's §5.3 "v1" pack verbatim (see UNVERIFIED note below on why nothing newer was substituted).
- `lib/jobs/kinds/jev-window.ts` — step-machine job kind (`collect`/`ask` steps, batched, resumable under `MAX_STEP_MS`), reading `jev_window_text` (J0), skipping windows with no English text (writes a `skipped:no_english` row, no Jev call), writing one `jev_window_signal` row per window.
- `lib/brain/fuse/jev-arm.ts` — `runJevArm()`, a pure function (signals + cues + sessions → visits + unbound), following §5.4/§5.6: opens on `p_start`, closes on `p_end` or a gap of `ETA_JEV_MAX_GAP_WINDOWS` non-clinical windows or day-end; `p_start`/`p_end` firing in the same window closes-then-reopens; fewer than `ETA_JEV_MIN_VISIT_WINDOWS` windows is filtered to `unbound: too_short`; a `consult_mark` cue with `individual_uid` inside the tape span binds the uid and sets `state: "in_chair"`.
- `lib/mcp/tools/fuse.ts` — extended `runArm()`/`ARMS` for `"jev"`, added `readJevSignals()`/`readSessionsForJev()`, and an X4-style `no_jev_signals` guard (no rows for the room-day ⇒ refuse to write anything, name the failure) mirroring `gemini-arms.ts`'s pattern.
- `lib/brain/fuse/types.ts` — `ARMS` gained `"jev"`; `OpenedByKind` gained `"jev_window"`.
- Tests: `tests/unit/jev-arm.test.ts` (8, pure-function), `tests/unit/jev-window-job.test.ts` (6, job-level against a fake db + the mock, including the required dry run on `tests/fixtures/jev/day-clean.json`), and a new describe block appended to `tests/unit/fuse-arms.test.ts` (3, `scribe_fuse_run` with `arm=jev` end to end: the guard, one visit written with `arm='jev'`, and idempotent re-run).

**J3 — the role signal**
- `db/migrations/0107_jev_role_signal.sql`.
- `lib/jev/prompts/role-v1.ts` — `roleQid()`, the per-speaker role question.
- `lib/jev/role-composite.ts` — `compositeRole()`: acoustic (`room_turn_speaker.clinician_id`/`match_confidence`) always outranks the text answer; text alone never assigns a `clinician_id`; below the confidence floor the speaker is left `null` with `reason: "low_confidence"`.
- `lib/jobs/kinds/jev-role.ts` — single-step job kind (documented as a simplification vs. `jev-window.ts`'s batching; a future slice can split it if bench-only volumes stop being small), groups `room_turn_speaker` turns by `speaker_idx` per diarize window, drops a speaker under the char floor, asks Jev once per surviving speaker, writes one `jev_role_signal` row, `force` re-runs an already-signalled speaker.
- Tests: `tests/unit/jev-role.test.ts` (9): `compositeRole()` pure cases, kind registration, grouping/char-floor, composite precedence inside the kind, and force re-run.

**Registration** — `lib/jobs/kinds/index.ts` (both new kinds), `lib/mcp/surface.ts` (`JEV_TOOLS` spread in), `lib/mcp/tools/jev.ts` (`scribe_jev_window_run` invoke, `scribe_jev_signals` read).

**Fallout fixed in existing tests (no production logic in the "don't touch" list was changed):**
- `tests/unit/tier2-jobs.test.ts` — `JOB_KIND_NAMES` updated for the two new kinds ("seven kinds" wrapper text; "all ten" → "all twelve").
- `tests/unit/mcp-surface-aliases.test.ts` — `PRIMARY_COUNT` 28 → 30 (the two new ungrouped tools).
- `docs/operator-mcp/TOOL-NOTES.md` — header count and the "other N ungrouped tools" list updated to name `scribe_jev_window_run` / `scribe_jev_signals`, per that file's own self-checking test.

## Doc edit (included in this commit)
`docs/handoff/ETA-JEV-INTEGRATION.md` §1 table: Use B **Gate** cell → "OPEN since 18 Sep 2026 — V cleared D1 in Cowork: Even is on a TypeSafe trial with no training on our data and zero data retention. J4 may run once J1–J3 pass refutation."; **Status 19 Sep** row → "In force" / "Unblocked; J4 after J1–J3 refutation." — exact text as specified.

## Migration numbers
Next free after 0105 in both this worktree and `-ow`: **0106** (`jev_window_signal`), **0107** (`jev_role_signal`). Both additive, `IF NOT EXISTS`, self-recording in `schema_migrations`.

## J0 reconciliation delta
Read `db/migrations/0105_jev_window_text.sql`, `lib/jev/english.ts`, `lib/jev/translate.ts`, `lib/jobs/kinds/jev-english.ts` in full before building. No delta required in J0's own files — J2's `jev-window.ts` reads `jev_window_text` exactly as J0 wrote it (`window_id`, `english` nullable). The only J0-shaped surprise was structural, not a defect: J0 never populates a per-turn English field (see UNVERIFIED #2 below), so Arm D's role signal (J3) necessarily asks Jev in the original language for now — documented as a known v1 limitation in `jev-role.ts`'s header, in scope per §9 as a called-out simplification, not silently done.

## UNVERIFIED items resolved from code
1. **Tape-ms → wall-clock helper.** None exists. `db/migrations/0057_bench_window.sql` establishes `bench_window.start_ms/end_ms` as session-relative; `rules.ts` computes `visit.tape_start_ms/tape_end_ms` inline as `sessionStartMs + offset` (both already epoch ms). `jev-arm.ts` mirrors this inline, with the reasoning spelled out in its header comment rather than inventing a shared helper the rest of the codebase doesn't have.
2. **Which `stt_turn` payload key holds English text.** Read `buildTurns()` in `lib/mcp/tools/bench.ts`: the only text key is `payload.text`, and it is always original-language ASR output. J0 supplies English only at the window level (`jev_window_text`), never per turn. `jev-role.ts` therefore sends `payload.text` as-is (flagged as a v1 limitation, future work, not something this slice's allowed-changes list authorized fixing).
3. **How `rules.ts` treats a mark-only visit with no uid.** It sets `state: "unknown"` (`v.individual_uid = null`, no `"ended"`). `jev-arm.ts` mirrors this exactly: no matching cue ⇒ `state: "unknown"`, `individual_uid: null`.

## Spec point not followed as literally specified, and what was done instead
§5.4 fixes Arm D's `DraftVisit.state` at `"in_chair"` (never `"ended"`) while also asking for `end_reason ∈ {jev_end, jev_gap, next_opener, day_end}` on the same draft. The shared `writeVisits()` path in `fuse.ts` (used by every arm, not forked for Arm D) nulls `end_reason`/`ended_at` unless `state === "ended"`. Resolved by keeping `end_reason`/`ended_at` on the pure `DraftVisit` for introspection/tests, and additionally pushing the same firing-rule string into `reasons` — which the spec itself says should carry "the firing rule and the p values" and which the shared write path persists unconditionally regardless of state. Documented at length in `jev-arm.ts`'s header comment.

No wording-trial results were found on `vinay/jev-armd-wording-trial` or in `docs/handoff/scratch/` (checked `wording_trial.py`/`fixtures.py` and the scratch directory) — the spec's §5.3 "v1" wording pack was shipped verbatim, which is also what the trial fixture itself calls "v1".

## Verification (all run in this worktree, mock-only)
- `npx tsc --noEmit -p tsconfig.tests.json` — clean, exit 0.
- `npx tsc --noEmit -p tsconfig.json` — clean, exit 0.
- `node --check` on every `.mjs` in the repo (`scripts/smoke.mjs`, `scripts/check-silent-failures.mjs`, `services/audio-join/container/server.mjs`, `services/audio-join/container/join-core.mjs`, `services/audio-join/scripts/join-real-file.mjs`) — all exit 0. None were added or touched by this slice.
- `npx vitest run` — **136 test files passed, 3092 tests passed, 1 skipped, 0 failed.** Tail:
  ```
  Test Files  136 passed (136)
       Tests  3092 passed | 1 skipped (3093)
    Start at  20:32:59
    Duration  88.18s (transform 3.39s, setup 0ms, collect 16.46s, tests 427.02s, environment 11ms, prepare 3.59s)
  ```
  Test count before this slice's new files: 3061 (3093 total after minus the 32 new tests this slice added: 6 jev-client + 8 jev-arm + 6 jev-window-job + 9 jev-role + 3 fuse-arms arm-D block).
- **`jev-window` dry run on `tests/fixtures/jev/day-clean.json` through the mock**, asserted in `tests/unit/jev-window-job.test.ts` ("day-clean.json dry run through the mock"): one `jev_window_signal` row per window (12/12), matching the fixture's phase/p_* values, `prompt_version: "jev-arm-d-v1"`. PASSED.
- **`scribe_fuse_run` with `arm=jev` writing visits with `arm='jev'`**, asserted in `tests/unit/fuse-arms.test.ts` ("10 — arm D (jev)"): the no-signals guard (`no_jev_signals`, nothing written); one visit written with `arm='jev'`, `state='in_chair'`, `individual_uid` adopted from a bound `consult_mark` cue, `opened_by_kind='jev_window'`; and idempotent re-run (`written:0, already_existed:1`). PASSED.

Full log: `docs/handoff/scratch/jev-build-19-SEP-2026.log`.

## J4 — documented only, never run
Slice J4 (the live bench runner) is out of scope for this build and was not built or executed. Once J1–J3 pass refutation, the spec's own §7 commands are (for reference; do not run without explicit authorization and a real room-day):
```
scribe_job_submit  { "kind": "jev_window", "args": { "room_day_id": "<real room-day id>" } }
scribe_job_submit  { "kind": "jev_role",   "args": { "room_day_id": "<real room-day id>" } }
scribe_fuse_run     { "room_day_id": "<real room-day id>", "arm": "jev", "dry_run": false }
```
Each requires `ETA_JEV_ENABLED` set (never set in this build or its tests) and a real `jev_window_text` (J0) row for the room-day.


## Refuter pass (19 Sep, second commit): F1 reconciliation and F2–F8 fixes

**FAIL verdict, eight findings.** F1 is a reconciliation, not a code fix; F2–F8 are code fixes, each with an added test. All work stayed in this same worktree (`vinay/jev-arm-d`), mock-only, J4 still not built or run.

**F1 — D1b reconciliation (documentation only, no code).** The D1 clearance recorded in this build's first commit (and in `ETA-JEV-INTEGRATION.md` §1) did not come from this build: the orchestrator (Fable) instructed it on V's explicit statement in Cowork on 18 Sep 2026 that Even's TypeSafe trial has no training on our data and zero data retention. This build only recorded that instruction; it never observed, obtained, or independently verified V's statement. The spec copy on the Mini (`ETA-JEV-ARM-D-SPEC-v1.0-18-SEP-2026.md`) had drifted from `ETA-JEV-INTEGRATION.md` — its own §0 and §11 still called D1b "STILL CLOSED" — so both documents now read consistently: "D1b CLEARED 18 Sep 2026 by V in Cowork (trial terms: no training, zero retention); J4 runs after J1–J3 refutation."

**F2 — `jev-arm.ts` gap-vs-explicit-start ordering.** The explicit-start rule (`p_start >= ETA_JEV_T_START`) now fires unconditionally, before the gap/clinical check, while a visit is open — a strong opener is never swallowed by a low `p_clinical` on the same window. Test: `tests/unit/jev-arm.test.ts`, "F2 — a strong opener is never swallowed by a low p_clinical gap check".

**F3 — `jev-arm.ts` session partitioning.** Signals are partitioned by `session_id` before the walk; a visit never spans two bench sessions, closing with the new `session_end` reason at every non-last session boundary (`day_end` only for the chronologically last session). Test: `tests/unit/jev-arm.test.ts`, "F3 — visits never span sessions".

**F4 — `jev-role.ts` off-menu role answers.** A Jev role answer outside the five CHECK-constrained roles is mapped to `other` (never aborts the job, never reaches the CHECK constraint directly), with the raw off-menu value recorded in a new `jev_role_signal.note` column. `db/migrations/0107_jev_role_signal.sql` (unreleased, edited in place) adds `note text` and makes `prompt_version` `NOT NULL`. Test: `tests/unit/jev-role.test.ts`, "F4 — an off-menu Jev answer never reaches the CHECK constraint or aborts the job".

**F5 — `client.ts` trace finalisation.** The llm-trace is now finalised with `status: "errored"` on every non-success exit path — retry exhaustion, a timed-out attempt, a caller abort, and any other thrown fetch error — not only the explicit 401/422 branch, via an idempotent `finaliseError` helper plus an outer catch-all. Tests: `tests/unit/jev-client.test.ts`, "F5 — the trace is finalised on every non-success exit path" (thrown fetch error, timeout, and caller-abort cases).

**F6 — `jev-window.ts` batching, token accounting, and concurrency.**
  (a) Batches are sliced from the full ordered window list (English or not); a no-English window keeps its place as a `{id, text: null, note: "no English text"}` placeholder so Jev's own window numbering stays consecutive, while its skip row is still persisted immediately in `collect` as before.
  (b) Each target window's `input_tokens` is now the batch's raw token total divided by the number of target windows in that batch (rounded); the job summary still sums the raw batch total once per call.
  (c) A new in-flight semaphore (`acquireJevSlot`/`_jevInFlightForTests`) caps concurrent Jev calls per spec §5.2: 2 per room-day (`ETA_JEV_MAX_INFLIGHT_PER_JOB`), 4 module-wide (`ETA_JEV_MAX_INFLIGHT_GLOBAL`).
  Tests: `tests/unit/jev-window-job.test.ts`, "F6(a)", "F6(b)", "F6(c)" (the last asserting at most 2, then at most 4, concurrent calls actually overlap).

**F7 — `jev-role.ts` non-English gating (new limitation, documented here as required).** `detected_language` is NULL on every row in this schema (a pre-existing, previously documented fact — see the UNVERIFIED items above), so there is no direct signal of whether a window's turns are genuinely English. F7 instead reads J0's own `jev_window_text.source` per window: `run_english`/`native_en` are treated as confirmed English; anything else (`translated`, `empty`, `not_ready`, `failed`, or no row at all) skips that window's role questions entirely, recording `windows_skipped_non_english`, unless the new env flag `ETA_JEV_ROLE_ALLOW_NON_ENGLISH` (default off) is set. **Known limitation:** this is a proxy, not a direct language check — a window J0 marked `run_english` that is in fact code-mixed will still be asked about in English, same as before this fix; F7 only stops the reverse case (asking about text J0 itself never confirmed as English). Tests: `tests/unit/jev-role.test.ts`, "F7 — non-English (or unconfirmed) windows are skipped by default" (three cases: `translated` source, no row at all, and the flag opting back in).

**F8 — phase-confidence env, gap windowCount, streak anchor, highest-confidence speaker id, cluster_id.** In `jev-arm.ts`: the phase-confidence floor is now `ETA_JEV_T_PHASE_CONF` (env, default 0.6, was a bare literal); a gap window never increments `windowCount`; a phase-streak visit now opens at the FIRST of its two qualifying windows (`windowCount` seeded at 2). In `jev-role.ts`: a speaker's `clinician_id`/`match_confidence` now come from whichever of their turns has the HIGHEST `match_confidence` (not whichever turn was read first), and `cluster_id` is populated from `room_turn_speaker` when present. Tests: `tests/unit/jev-arm.test.ts` ("F8 — ETA_JEV_T_PHASE_CONF is env-overridable", "F8 — a gap window never increments windowCount", "F8 — a phase-streak visit opens at the FIRST of its two qualifying windows") and `tests/unit/jev-role.test.ts` ("F8 — the highest match_confidence...", "F8 — cluster_id is populated...").

**New REQUIRED PROOF test.** `tests/unit/jev-migrations-0106-0107.test.ts` proves 0106 and 0107 apply, in numeric order, against a real `postgres:16` already carrying every migration through 0105 — the actual dependency both new tables have (`REFERENCES bench_window(id)`) — and additionally proves F4's edited 0107 (`prompt_version NOT NULL`, `note` column present). Run against Docker on the Mini (`open -a Docker`, `docker info` became ready) — PASSED.

**Verification after F2–F8.** `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.tests.json` both clean. `npx vitest run` — see the tail quoted in the message accompanying this commit for the exact post-fix pass/fail/skip counts, including the new migration proof test and the REQUIRED PROOF suite's Docker-backed tests.
