# ETA-E16 — an emotion score must mean something · BUILD REPORT · 14 Sep 2026 · Builder (`scribe`)
Supersedes this file's 21:10 stop report; its measurements are carried into `ETA-E16-RULING-BUILD-OPTION-A` §1.

## 1. Commit
**No commit.** Built under option A and green on everything that can run. The gate is red only on the 4 Docker
REQUIRED PROOF guards — and **this round's own SQL proof is inside one of them** (§4). V waived that for E11;
I have not self-accepted it for a new round. Commit on your word, then stage by exact name.
Branch `vinay/e16-emotion-speech-fraction` from `ccd12b0`, in its own worktree
(`/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-e16`, the repo's `…-slice-e` precedent). The shared clone had
another pane's uncommitted E17 in it, and a `git switch` there would have moved HEAD under that pane. Not pushed.

## 2. Gate (in the worktree)
- `npm run typecheck` → exit 0.
- `npm test` → exit 1: `Test Files 4 failed | 106 passed (110)`, `Tests 4 failed | 2547 passed | 98 skipped (2649)`.
  The 4 are REQUIRED PROOF guards: `c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored`, `s1-fix2-migrations`. **UNRUN.**
- `ETA_ALLOW_SKIP_E2E=1 npm test` → exit 0: `Tests 2551 passed | 98 skipped (2649)`. The +4 skipped are E16's new pg cases.
- `npm run build` → exit 0. `npm run check:silent` → the accepted 9, none in changed files.
- `swift build` → `Build complete! (24.70 sec)`, a fresh `.build`. **`swift test` → `600 tests in 48 suites passed`.**
  So the main clone's `TestingMacros` failure is that clone's `.build` directory, not the source (F5, E21).

## 3. Diff by file (+/−)
- `db/migrations/0097_room_span_emotion_speech.sql` +67
- `lib/emotion/client.ts` +40/−3: `/health` must carry `min_speech_s`; a gate refusal maps to `unscorable`.
- `lib/emotion/segments.ts` +60: `speakerSpeechMs`, a union of one speaker's intervals clipped to the span;
  `splitByDiarizedSpeech`, which splits at `min_speech_s`.
- `lib/emotion/store.ts` +87/−26: `stateFor`, `writeUnscorable`; both speech numbers and `speech_basis` on every
  row; `segments_unscorable` counted, written and compared (rule 15); the zero-scored rule.
- `lib/jobs/kinds/emotion-window.ts` +39/−15: reads `segments_json`, measures, pre-filters.
- `tests/fixtures/e16-a9-window.json` +257: E14's window, **timings only**, read from the database.
- `tests/unit/e16-emotion-speech-fraction.test.ts` +304 (new).
- `tests/unit/c3-emotion.test.ts` +3/−2: health fixtures now carry `min_speech_s`, on purpose.
- `tests/unit/s1-emotion-zero-scored.test.ts` +68/−7: applies 0097; real `segments_json`; 4 new E16 cases.

Nothing else moved. `app.py`, `room-drain.ts` and `auto-drain.ts` are untouched. No service was restarted.

## 4. V1–V7
- **V1 — SUPERSEDED by ruling A1 (no cutoff), stated.** Under option A, A9 holds 2,280 ms of its speaker, over the
  1.5 s minimum, so it is sent and scored. What holds instead: its row carries `speech_ms` 2280 over a 29,070 ms span,
  fraction **0.078**. The test builds it from the real fixture. The fixture is proven faithful: today's planner
  reproduces all 13 of E14's span bounds, and the per-chunk speech matches the independent SQL to 10 ms
  (3729 / 2280 / 320 / 4532 / 4985 ms).
- **V2 — PASS for the job, UNRUN for the SQL.**
  - E14's exhausted shape (one 0.50 s span) now ends `no_segments` in `prepare`: nothing sent, no failed row, `unscorable: 1`.
  - A window whose sent spans are all refused writes rows `unscorable`, never `failed`.
  - **The rule itself** (`planned − unscorable_sent > 0 AND scored = 0`) has 3 pg cases, UNRUN: all refused → `ok`;
    refused + failed → `failed`; never-sent rows are not subtracted.
- **V3 — PASS.** `inference_failed` on a sent span is written `failed`, not unscorable, and a zero-scored finish fails
  the job with `emotion_zero_scored`. The partial-labels case stays `malformed_scores`.
- **V4 — PASS.** A gate refusal writes `speech_ms` 3730 **and** `service_speech_ms` 420 with basis `diarize_segments`.
  A scored span writes `speech_ms` and a NULL service number. Never-sent rows carry their speech in the INSERT.
- **V5 — PASS.** `min_speech_s` is required from `/health` (missing, a string, 0, −1, ≥ cap or NaN → `health_min_speech_unreadable`).
  Driven at a non-default **2.5** on the wire, the job sends 3 of A9's spans, not 4.
- **V6 — mechanism built; behavioural proof UNRUN.** 0097: `speech_basis text NOT NULL DEFAULT 'pre_speech_fraction'`.
  Query: `SELECT speech_basis, state, count(*) FROM room_span_emotion GROUP BY 1, 2`. There is a pg case, plus a
  source-text supplement.
- **V7 — mutation check: 16 of 16 caught.** Each applied by exact string and restored with a sha256 match. Each line
  gives the two behaviours it separates:
  - **E1** pre-filter removed (sent vs never-sent) — 6 failed
  - **E2** `min_speech_s` hard-coded (read vs 1.5) — 1
  - **E3** `/health` minimum not required (refused vs accepted) — 1
  - **E4** unscorable mapping removed (unscorable vs malformed) — 3
  - **E5** empty-labels arm removed — 1
  - **E6** mapping over-broad to partial labels (model fault vs silence) — 2
  - **E7** `stateFor` writes failed (row unscorable vs failed) — 2
  - **E8** speaker filter removed (this speaker vs anyone) — 1
  - **E9** union removed (overlap once vs twice) — 1
  - **E10** service number dropped (both vs one) — 1
  - **E11** basis not written (post-fix vs default) — 2
  - **E12** never-sent row loses `speech_ms` — 1
  - **E13** unreadable-segments guard removed (named failure vs silent `no_segments`) — 1
  - **E14** `no_segments` count dropped — 1
  - **E15** SQL: refused spans not subtracted — 1
  - **E16** SQL: never-sent rows subtracted too — 1

  **E15 and E16 are caught only by a source-text supplement** (the statement text and its bound reason). Their
  behavioural test is the pg suite. The floor mutation the spec named does not apply: by ruling, no floor exists.

## 5. P4 — no cutoff, and the query that will set one
The 26 scored rows measured under this basis (p10 0.295, p50 0.755; the two known-bad at 0.078 and 0.181) are too
thin to set a floor on. **After a clinic week:**
`SELECT state, count(*), percentile_cont(ARRAY[0.05,0.1,0.25,0.5]) WITHIN GROUP (ORDER BY speech_ms / ((clip_end_s - clip_start_s) * 1000.0)) FROM room_span_emotion WHERE speech_basis = 'diarize_segments' AND state IN ('scored','unscorable') GROUP BY state;`
read beside a listened sample of the 20 lowest-fraction `scored` spans.

## 6. SQL and schema assumptions
- **0097 in full is in the file.** Three `room_span_emotion` columns: `speech_ms`, `service_speech_ms`, `speech_basis`
  (DEFAULT `pre_speech_fraction`, CHECK with `service_speech_est` reserved and commented). `speech_ms_chk` ≥ 0.
  `state_chk` widened with `unscorable`. `room_emotion_window.segments_unscorable`. Constraints are dropped-if-exists,
  then added. Not executed anywhere: no Postgres is reachable (Docker down, no server binary). **INFERRED.**
- **The zero-scored statement (`store.ts` `finishEmotionWindow`)** now counts
  `count(*) FILTER (WHERE state = 'unscorable' AND reason IS DISTINCT FROM $PREFILTER_REASON::text) AS unscorable_sent`
  and decides `(planned − unscorable_sent > 0 AND scored = 0)`. **INFERRED** until the pg suite runs.
- `segments_json` offsets are clip-relative ms. **INFERRED, and confirmed on A9's real rows.**
- **HAZARD, not built around:** `recordDiarizeWindow` keeps an `ok` row's `segments_json` when a later diarize run
  succeeds and only `last_run_id` moves (`diarize-window.ts:285`, `:297`). The emotion job reads turns for the new run but
  intervals from the old one. If speaker indices differ between the runs, `speech_ms` is measured against the wrong
  speaker. It is rare (a manual re-run of an `ok` window). Own item.

## 7. Deviations and flags
- **D1 — `speech_basis` is `NOT NULL DEFAULT 'pre_speech_fraction'`**, not the approved nullable column plus backfill.
  The DEFAULT also stamps rows that production's pre-E16 code writes **between the migration and the deploy**. A
  nullable column would leave those unmarked.
- **D2 — `/health` without `min_speech_s` now fails the window `emotion_unavailable`.** The live service reports it (1.5).
- **D3 — a window whose every sent span is refused ends `ok` with 0 scored.** It is final and costs no attempt, per
  V2. A window whose spans are all never-sent ends `no_segments`.
- **F1 — `vinay/s1-auto-drain` moved.** `e925901` (E17) was committed onto it at 21:22 by another pane. The
  E16 ruling said that branch must not move while E11 is under review. Not mine; untouched.
- **F2 — three-way speech disagreement:** named (ruling §5), not built. So are Whisper's VAD mapping and the service contract.

## 8. Manual steps for V
- **Apply 0097 BEFORE deploying E16:** `psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0097_room_span_emotion_speech.sql`.
  The new code writes the new columns. The old code keeps working after the migration because of the DEFAULT.
- **The emotion pg suite must run once Docker is back** — it is the only behavioural proof of the rule and of 0097.

Subagents: none.
