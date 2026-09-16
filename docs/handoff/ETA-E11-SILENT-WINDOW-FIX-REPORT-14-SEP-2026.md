# ETA-E11 — a quiet room is not a failed read · REPORT · 14 Sep 2026 · Builder (`scribe`)

**NO COMMIT.** The fix is built and passes 16 of 16 new tests, with 9 of 9 mutations caught. Two gate lines are red, and
neither comes from this diff (§2): `npm test` fails on the 4 Docker "REQUIRED PROOF" guards, and `swift test` has 1 lock
issue. The kickoff says commit only if the tests are green, so the change sits uncommitted on `vinay/s1-auto-drain` @
`f798edf`. Commit on your word. The files would be staged by exact name: the three below.

## 1. The diff
- `lib/stt/room-drain.ts` +71 / −1:
  - `:41` imports `EMPTY_TRANSCRIPT` from `@/lib/whisper-constants`.
  - `:736-804` adds the silent branch in `roomWindowSegment`. The condition is
    `if (!full.ok && full.error === EMPTY_TRANSCRIPT)`, and it sits before the unchanged `whisper_unavailable` branch.
  - `:1288` is a one-line doc fix on `roomWindowFinish`.
- `lib/jobs/kinds/room-window.ts` +6 / −1:
  - The `segment` case goes to `finish` when `next_progress.silent_window === true`, and to `engine` otherwise.
  - The job's done result gains `silent_window`.
- `tests/unit/e11-silent-room-window.test.ts`: new file, 277 lines.

The silent branch runs the REAL `buildTurns` with `segments: []`, which yields exactly one `stt_silence`. It writes through
the same `writeWindowCues`, with a marker built from `segmentCount: 0` and `complete: true`, and returns
`silent_window: true`. `roomWindowFinish` then sets the window `transcribed` and the subject row `done`. `recordFailure` is
not reached, `resolveRouting` is not called, and no engine adapter runs. Untouched: `lib/whisper.ts`, `lib/emotion/`,
Whisper flags, env vars, `vercel.json`. No SQL string was added.

## 2. Gate (full output in session scratch; quoted lines)
- `npm run typecheck` → exit 0.
- `npm test` → **exit 1**: `Test Files 4 failed | 104 passed (108)`, `Tests 4 failed | 2509 passed | 94 skipped (2607)`.
  All 4 failures are `REQUIRED PROOF … ran, or was skipped deliberately`, because Docker is not available. **Suites that did
  NOT run:** `c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored`, `s1-fix2-migrations`.
- Informational only, not the gate: `ETA_ALLOW_SKIP_E2E=1 npm test` → exit 0, `Tests 2513 passed | 94 skipped (2607)`.
  The flag's own text says that acceptance is "a thing a person types", so I did not treat this run as green.
- `npm run build` → exit 0.
- `npm run check:silent` → exit 1, the 9 findings accepted at `1193083`, none in changed files.
- `swift build --package-path apps/room-recorder` → `Build complete!` (run before and after the retry below).
- `swift test` → **exit 1**: `Test run with 600 tests in 48 suites failed … with 1 issue`. The issue is
  `archive05RejectsIndexStreamRangeAndRecoveryEpochMismatches() … Caught error: .lockFailed(errno: 35)`
  (`ArchiveIndexPersistenceP1Tests.swift:457`). It is not a `needsEnrolment` issue. A `--filter` re-run did not reach the
  test: it failed to compile, with `external macro implementation type 'TestingMacros.SourceLocationMacro' could not be
  found`. **UNPROVEN whether it is a flake.** This diff touches no Swift (`git diff --stat -- apps` is empty).

## 3. V1–V6
- **V1 PASS, behavioural.** The real kind is driven step by step with Whisper answering `{ok:false, error: EMPTY_TRANSCRIPT}`.
  Result: window `transcribed`, subject row `done`, one cue batch whose turns are exactly `["stt_silence"]`, and a marker of
  type `stt_window` with `{complete: true, segment_count: 0}`. The job result is `{silent_window: true, segment_count: 0, run_id: null}`.
- **V2 PASS.** `http_500: …`, `timeout_180000ms`, `network: ECONNRESET`, `whisper_failed` and `http_502: empty_transcript`
  (the constant as a substring) each fail `room_window_failed: whisper_unavailable`. Each stops after `segment`, writes one
  attempt, returns the window to `closed`, and writes no cue.
- **V3 PASS.** Two consecutive silent drains of one window make **0** attempt writes, and the counter stays 0.
- **V4 PASS.** Steps visited are `prepare → segment → finish`. Router submits 0, `stt_routing` reads 0,
  `transcription_run` inserts 0, Whisper calls 2 (probe + full). Control: a spoken window still goes `segment → engine`
  and resolves its route, so the skip is not universal.
- **V5 PASS.** A table of 2 Whisper results × 3 paths — sync tool `scribe_transcribe_range` (dry run), the
  `transcribe_range` job, the `room_window` job — requires identical `{finished, silent, speech_turns}`. A sweep over
  `git ls-files -co` requires every caller of `transcribeWithWhisper` to be in that table or classified as not a window
  reader, with a reason. **Proven to fail:** an untracked `lib/e11-fourth-path-probe.ts` calling Whisper failed the sweep,
  and the probe was then deleted.
- **V6 PASS — 9 of 9 mutations caught.** Each was applied by exact string, run against the E11 file, and restored, with
  sha256 matching the original every time:
  - M1 `===` → `.includes()` — 1 failed (the `http_502: empty_transcript` case).
  - M2 → `!full.ok` — 6 failed (V2).
  - M3 `recordFailure` inserted in the silent branch — 1 failed (V3).
  - M4 kind always goes to `engine` — 4 failed.
  - M5 `silent_window` not set — 4 failed.
  - M6 marker `segmentCount` 0 → 1 — 1 failed (V1).
  - M7 room_window silent branch removed — 4 failed.
  - M8 sync tool K5 branch removed — 1 failed (V5 bench row).
  - M9 `transcribe_range` K5 branch removed — 1 failed (V5 row). The sweep probe above is a tenth, separate check.

## 4. Does `drainRoomWindow` accept a window in `failed`?
**Only with `force: true`.** `lib/stt/room-drain.ts:464-466`: `drainable` is `["closed","transcribing"]`, and with `force` it
is `["closed","transcribing","transcribed","failed"]`.
- Auto-drain never passes `force` (`lib/stt/auto-drain.ts:135`), so **the auto path will never re-pick the 7 parked windows,
  fix or no fix.**
- The one door that passes `force` from its caller is admin `POST /api/admin/bench/drain` `{window_id, force:true}`
  (`app/api/admin/bench/drain/route.ts:97`, admin cookie).
- `drainRoomWindow` does not read `stt_subject_job.attempts`. On a forced re-drain of one of the 7:
  - a silent result settles it `done` with no attempt write;
  - any real failure takes attempts to 4, and `recordFailure` parks it `failed` again at once (`attempts + 1 >= 3`);
  - `prepare` also re-joins the clip, one join call.

I did not re-drain any window. Recovery is yours.

## 5. Follow-up, named, not done: the shared helper
A single classifier of a Whisper result (`silent` | `failed` | `spoken`) would replace:
- `whisperNotOkAnswer`'s `EMPTY_TRANSCRIPT` test (`lib/mcp/tools/bench.ts:1814`);
- `transcribeStep`'s (`lib/jobs/kinds/transcribe-range.ts:217`);
- the new branch (`lib/stt/room-drain.ts:736`).

It must NOT be adopted by the callers the sweep lists as not window readers. The encounter pipeline (`process/route.ts`)
treats empty as a failure on purpose, because no note can be made from silence. The E11 table is the safety net that
extraction needs, and today it is the only one: CI does not run.

## 6. Flags
- **F1 — not tested:**
  - The four real-Postgres suites (§2).
  - The real brain write of a silence batch on the room path: `writeWindowCues` is captured, not called. The same function
    writing a silence is covered for the sync tool in `speech-turns-k5.test.ts`.
  - Any live drain.
- **F2 — a cue-write failure on the silent branch still costs an attempt** (`cues_refused`), exactly as on the speech path.
  A window whose silence could not be recorded was not read into the day. This is my implementation choice.
- **F3 — a silent window is now `transcribed` with no `transcription_run`.** `lib/admin/room-reads.ts:94,103` counts it as
  done and adds its 900 s into `words_ms`. The room card will count silence as transcribed time.
- **F4 — the language probe still runs first** on a silent window: 2 Whisper calls, not 1. Unchanged by this brief.
- **F5 — every `room_window` done result now carries `silent_window`** (false for speech). It is additive.
- **F6 — the kickoff names no base SHA or file list.** I checked its stated premise, that `lib`, `app` and `vercel.json`
  are identical between `fe021a3` and HEAD: `git diff --stat` is empty. It also cites `bench.ts:1786-1795`; the K5 doc
  comment starts at 1786, and the branch itself is at 1814.
- **F7 — the swift lock issue and the macro-plugin compile error on re-run** are outside this diff; worth a Debugger if they recur.
Subagents: none.
