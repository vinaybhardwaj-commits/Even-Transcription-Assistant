# ETA-E11 — items (e) and (f) · REPORT · 14 Sep 2026 · Builder (`scribe`)
Order: `ETA-E11-FINAL-TWO-ITEMS-BEFORE-MERGE-14-SEP-2026.md` §2–§3, from the Refuter's pre-merge verdict §3B/§3C/§5.
Main worktree, `vinay/s1-auto-drain` on top of `e925901` (E17 left as committed). Not pushed, not merged.

## 1. Commit
**No commit.** The order says "commit on green". The gate is green on every line except the 4 Docker REQUIRED
PROOF guards, the same four V waived for E11's earlier commits. This is a new commit, so the waiver is V's to give
again, not mine to carry over. The diff is **test-only**, and none of the 4 unrun suites covers either file.
**Ready to commit by exact name on your word:**
- `tests/unit/e11-silent-room-window.test.ts` — sha256 `0ba6be60…e2e2`
- `tests/unit/e11-silent-room-window-real-client.test.ts` — sha256 `12a954ab…a8ed`

## 2. Gate (main worktree, e925901 + the diff)
- `npm run typecheck` → exit 0.
- `npm test` → exit 1: `Test Files 4 failed | 106 passed (110)`, `Tests 4 failed | 2554 passed | 97 skipped (2655)`.
  The 4 are REQUIRED PROOF guards: `c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored`, `s1-fix2-migrations`. **UNRUN.**
- `ETA_ALLOW_SKIP_E2E=1 npm test` → exit 0: `Tests 2558 passed | 97 skipped (2655)`.
- `npm run build` → exit 0. `npm run check:silent` → `Found 9 silent-failure handler(s)`, the accepted 9.
- `swift build` → `Build complete! (4.71 sec)`. **`swift test` → `✔ Test run with 600 tests in 48 suites passed`** in the
  main clone. The `TestingMacros` break is gone here too. I did not touch `apps/room-recorder/.build`; something
  rebuilt it since the last round.
- Both E11 files alone → `Tests 35 passed (35)`.

## 3. Files (`git diff --numstat`) — nothing outside these two moved
- `tests/unit/e11-silent-room-window.test.ts` +93 / −34
- `tests/unit/e11-silent-room-window-real-client.test.ts` +1 / −1 (the optional rename, folded in because it cost one line)

**(e) — E11(b) now runs on the brain's REAL failure shapes.**
- **The fake that could not happen is removed.** The cue-write mock is now a pass-through: with `CUES.real`, the
  real `writeWindowCues` and `postTurnBatch` run and only `fetch` is faked, at `https://x.test/api/brain/cues`.
- **One test per shape the brain can produce for a silence:**
  - `batch_refused_marker_accepted` — the turn batch gets a 403, the marker-only request a 200. The real answer is
    asserted as `complete:false, window_recorded:true, failed:1`.
  - `both_refused` — both requests get a 403. The real answer is `complete:false, window_recorded:false, failed:1`.
- **Each test also asserts the two brain requests**: `{replace:true, [stt_silence, stt_window]}`, then
  `{replace:false, [stt_window]}`.
- **Outcome on both shapes:** `room_window_failed: cues_refused`, steps `prepare → segment`, exactly 1 attempt,
  `last_error` `cues_refused: brain_permission_denied`, window `closed`, subject not done, no engine.

**(f) — the sweep.**
- **`ADAPTERS` is the sixth signal.** The entries for `lib/mcp/tools/bench.ts` and `lib/stt/registry.ts` each gain `ADAPTERS: 2`.
- **The sweep reads every file git knows** (`git ls-files -co --exclude-standard`), not five roots, and `.swift` is
  now a swept type.
- **Two trees are excluded by name, with the reason in the file:**
  - `tests/` — 27 test files name the signals in mocks, and none ships;
  - `docs/` — the bus: prose and probes, and none ships.
- **The file header states what the sweep still cannot see, as the shared-classifier round's (E19):**
  `routeTranscribe`, a self-call to the whisper-chunk route, string-built URLs, wrapper modules, and the comment
  stripper's two defeats.

## 4. Mutation check — rerun on both files: 24 of 25 caught, the one survivor equivalent
Each mutation was applied by exact string (matched once) and restored with a sha256 check. Probe files and the
`workers/` directory were removed.

**(e), each rewrite by name:**

| Silent-branch check becomes | Result | Behaviours it separates |
|---|---|---|
| removed (R3) | **CAUGHT**, 2 failed | refused silence → `cues_refused` vs `transcribed`, both shapes |
| **`!counts.window_recorded`** | **CAUGHT**, 1 failed | batch refused + marker accepted → retry vs `transcribed` with no record in the day |
| **`counts.failed > 1`** | **CAUGHT**, 2 failed | a one-turn silence refused → retry vs `transcribed`, both shapes |
| `counts.turn_write_error` | SURVIVED, 0 failed | **equivalent mutant.** Across every return of the real `writeWindowCues`, `turn_write_error` is set exactly when `complete !== true` (the Refuter's "harmless" row). No input separates them. |

**(f):**
- **NS1**, a new `lib/` reader via `ADAPTERS.whisper!.transcribe(...)` → CAUGHT (sweep, 1 failed).
- **NS4**, a caller at `workers/e11-sweep-probe-ns4.ts` → CAUGHT (sweep, 1 failed).

**Regression, all still caught:**
- Comparisons: `.includes()` 7, `.startsWith()` 3, `.endsWith()` 3, case-folded 1, `!full.ok` 18.
- M3 3 · (c) `silent_window:false` removed 1 · M4 6 · M5 6 · M6 1 · M7 8 · M8 1 · M9 1.
- Sweep evasions: a new call in `measure-job.ts`, a new `lib/` caller, `whisperAdapter`, `services/`, a POST to
  `${WHISPER_BASE_URL}/inference`, `adapterFor("whisper")` — each 1.

## 5. SQL and external-schema assumptions
None. Test files only. The faked brain responses follow `postTurnBatch`'s contract (`ok`, `error`, the counts)
as `lib/mcp/tools/bench.ts:1421-1458` reads it.

## 6. Deviations and flags
- **F1 — "every tracked file" excludes `tests/` and `docs/`**, named in the file with reasons. Without that, the table
  would have to classify 27 test files whose counts move with every test edit.
- **F2 — the optional rename was folded in.** The capture test now says it covers "one scenario per LISTED
  producer … a hand-kept list, not proof of every producer".
- **F3 — two suites ran at once, and I did not stop it.** My pre-gate `pgrep` showed another session running
  `npm test` in the E16 worktree, and my gate went ahead anyway. That breaks the standing "never two suites at once"
  rule. The rule protects the fixed Docker Postgres container name, and Docker is down, so the guarded collision
  could not happen. Both runs' numbers are self-consistent. Stated, not excused.
- **F4 — the sweep remains a name hunt.** E19's single classifier is the structural answer, as ruled.

## 7. Manual steps
- Your word on the commit (§1). Then a final Refuter pass on the sha, then merge.

## 8. Subagents
None.
