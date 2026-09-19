# ETA-J2-BUILD-REPORT — Arm D window signals (persistence half)

Branch: `vinay/jev-j2` (follow-on off `vinay/jev-j1`, base `cdb6f67`). Slice J2, ETA-JEV-ARM-D-SPEC §5.
Scope of THIS commit: the signal-persistence half of J2 — migration, prompts module, `jev_window` job
kind, and tests. The pure fusion `runJevArm` → DraftVisits (§5.4) is the next commit on this branch
(see "Pending" below). Sha of this commit is the HEAD of `vinay/jev-j2` at filing.

## 1. What was built
- `db/migrations/0108_jev_window_signal.sql` — the per-window signal table. NOT APPLIED.
- `lib/jev/prompts/arm-d-v1.ts` — `PROMPT_VERSION="jev-arm-d-v1"`; the five Arm-D questions, verbatim
  from the trials, built per target window (batched); `ARM_D_SETTING` state framing.
- `lib/jobs/kinds/jev-window.ts` — the `jev_window` job kind (classify → ask), registered in
  `lib/jobs/kinds/index.ts`.
- Tests: `tests/unit/jev-window.test.ts` (8), plus `tests/unit/tier2-jobs.test.ts` kind-list updated
  (ten → eleven; adds `jev_window`).

## 2. Gate (all green)
- `npm run typecheck` → exit 0.
- `npm test` (`typecheck:tests` + vitest) → 134 files, **3076 passed / 1 skipped**, exit 0
  (jev-window 8/8, tier2 37/37).
- `npm run build` → exit 0.
- `npm run check:silent` → the 9 accepted pre-existing findings only; none in `lib/jev` or the new kind.
- Swift/room-recorder not exercised (TS-only slice).

## 3. Migration number — DEVIATION, flagged for your ruling
The order named **0107**; I used **0108**. 0107 is already taken by `0107_jev_role_signal.sql` on
`vinay/jev-arm-d` (the unmerged monolithic Arm-D branch, which also carries a `0106_jev_window_signal`).
`run-migrations/route.ts` selects by version with ON CONFLICT DO NOTHING and cannot report a clash, so
reusing 0107 would silently skip one table's DDL at merge. **0108 is verified free on every branch
head and absent from the live DB (schema_migrations max = 105).** I also treated `vinay/jev-arm-d` as
superseded by the sliced rebuild (per the ruling to build J0→J1→J2 as slices). Both assumptions are
yours to confirm; renumbering a fresh unmerged migration is trivial if you want 0107.

## 4. The three states on a row (absence never shares a value with failure)
`jev_window_signal.status` is a first-class column, NOT overloaded onto `phase` (non_clinical is a real
Jev answer):
- `not_ready` — no usable J0 English yet (no `jev_window_text` row, or its source is itself
  non-terminal), OR Jev gated off (`ETA_JEV_ENABLED` unset). `error` = `j0_not_ready` | `jev_disabled`.
  NOT terminal: re-evaluated every run; resolves on its own once J0 lands / the flag is on.
- `empty` — a usable J0 source with no text (`english` empty). Terminal, `error` NULL.
- `failed` — Jev was asked and the call failed. Terminal for the attempt, RETRYABLE; `error` =
  `jev_transport` | `jev_state_too_large` | `jev_error`.
- `ok` — answered; `phase`, `phase_probs`, `phase_confidence`, `p_start/p_end/p_clinician/p_clinical`,
  `model`, `prompt_version` populated.
Skip set on a normal re-run = `{ok, empty}` only; `not_ready`/`failed` re-process. `force` re-runs all.

## 5. Questions wired (verbatim, as trialled) and batching
Five per target window, one `jev_ask` call per batch (never one call per question):
- `phase` (6-way choice, v1): "Which phase of a patient consultation does window {W} mainly show? …"
- `start` (noul): "Does a new patient's consultation begin in window {W} …different patient…?"
- `end` (noul): "Does the current patient's visit finish in window {W} — final advice/follow-up…goodbye…leaving?"
- `clinician` (noul, action): "In window {W}, does the treating clinician speak to the patient — asking…examining…prescribing?"
- `clinical` (noul): "Does window {W} contain any clinical conversation between a clinician and a patient or attendant?"
  — spec §5.3 v1; the brief named chosen wordings for start/end/clinician but NOT for `clinical`, so v1
  stands. FLAG for confirmation.
Batches: `ETA_JEV_BATCH_WINDOWS` (default 20) target windows + `ETA_JEV_CONTEXT_WINDOWS` (default 2)
preceding windows as read-only context; ordinal labels (W1, W2, …) only — never ids or timestamps.
NO SILENT TRUNCATION: a batch over the client's state guard (`JevStateTooLargeError`) is halved and
retried; a single window still too large is recorded `failed(jev_state_too_large)`, never clipped.

## 6. Thresholds — where they are configured
Read from env (movable without a code change), for the pending `runJevArm` fusion: `ETA_JEV_T_START`
0.70, `ETA_JEV_T_END` 0.70, `ETA_JEV_T_CLINICAL` 0.60, `ETA_JEV_MIN_VISIT_WINDOWS` 3,
`ETA_JEV_MAX_GAP_WINDOWS` 6. Batch/context: `ETA_JEV_BATCH_WINDOWS` 20, `ETA_JEV_CONTEXT_WINDOWS` 2.
These trial AUCs are on synthetic fixtures and are an UPPER BOUND; real code-mixed windows separate
less cleanly — hence env thresholds.

## 7. SQL / live-schema verification (verified read-only against the live DB, not inferred)
- `bench_window`: `id text NOT NULL` (PK, FK target), `session_id text NOT NULL`,
  `room_day_id text NULLABLE`, `start_ms bigint NOT NULL`, `end_ms bigint NOT NULL`.
- `jev_window_text`: `english text NULLABLE`, `source text NOT NULL`, CHECK =
  `{run_english,native_en,translated,empty,not_ready,failed}` (live).
- `jev_window_signal`: did not exist; `schema_migrations` max = 105.
Statements the kind issues (verbatim):
- `SELECT id, session_id, start_ms, end_ms FROM bench_window WHERE room_day_id = $1 ORDER BY start_ms`
- `SELECT window_id, source, english FROM jev_window_text WHERE room_day_id = $1`
- `SELECT window_id, status FROM jev_window_signal WHERE room_day_id = $1`
- `SELECT id, session_id, start_ms, end_ms FROM bench_window WHERE id = ANY($1)`
- `SELECT window_id, english FROM jev_window_text WHERE window_id = ANY($1)`
- upsert `INSERT INTO jev_window_signal (…18 cols…) ON CONFLICT (window_id) DO UPDATE …`

## 8. COST
Unit tests make ZERO real Jev calls (injected client / no vendor). One synthetic non-PHI batch smoke
validated the real path end-to-end (Use A; scaffolding not committed): 5 questions × 3 target windows
+ 2 context = **1 call / 15 questions / input_tokens 1637 / latency 1786 ms / est $0.000069**
(`model jev-1.13.0`; price input_tokens × 42e-9, output unpriced). A full room-day batches to a handful
of calls — well under the spec §10 ~$0.01/room-day estimate. `input_tokens` is stored per row as the
batch total keyed by `batch_id`; room-day cost = SUM over DISTINCT `batch_id`.

## 9. Manual steps for V
- Apply migration `0108_jev_window_signal.sql` (after confirming the number) — the Builder did not.
- The job was NOT run against live data (forbidden). No live signals written.

## 10. Pending (next commit on this branch)
- `lib/brain/fuse/jev-arm.ts` — pure `runJevArm(cues, signals): ArmOutput` → DraftVisits, gating on the
  §6 env thresholds. The spec marks its DraftVisit wall-clock mapping helper and mark-only-uid handling
  UNVERIFIED (mirror `rules.ts`); I will verify against `rules.ts` before writing it.

## 11. Subagents
One general-purpose Researcher — distilled the J1/J2 contract from the 36 KB spec (locations + verbatim
identifiers). No other subagents.

## 12. Queue/carryover note
Nothing in this slice changes an assertion in `ETA-BUILD-QUEUE.md` / `ETA-CARRYOVER.md` that I am aware
of, EXCEPT the migration number: if either asserts J2 = 0107, it now needs 0108 (or your renumber).
