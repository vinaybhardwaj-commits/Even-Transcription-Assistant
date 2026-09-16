# ETA-E11 — PRE-MERGE REPORT · 14 Sep 2026 · Builder (`scribe`)

Orders: sections 1–2 of `ETA-E11-FINAL-RULINGS-AND-SCRIBE-ORDER-14-SEP-2026.md`, plus §1 of
`ETA-E14-E15-RULINGS-AND-SCRIBE-ANSWERS-14-SEP-2026.md`. **Not merged. No PR.** `apps/room-recorder/.build` left alone.

## 1. Commits
- **`6e68462f2d92277d8048faf74d5f68bebc63a386`** — the E11 fix, pushed first. The remote went `a4b43a1..6e68462`, a
  fast-forward. Before the push, its three files matched the Refuter's sha256 pins (`7144f83f…4646`, `41f47b08…9b30`,
  `6f4afce3…591f`). The push also published `f798edf` (the K1 defect record, not mine). I scanned it first: only
  room, window and session ids, and no names, secrets or clinical text.
- **`ccd12b035470562fe291b8e189b46e1804c9f2ae`** — items (a)–(d), pushed. The remote went `6e68462..ccd12b0`, and
  `git ls-remote` returns `ccd12b0…`. **For the Refuter's pin, sha256 at commit:**
  - `339650c7…211e` `lib/stt/room-drain.ts`
  - `3fc6837d…610a` `tests/unit/e11-silent-room-window.test.ts`
  - `555856ea…e10a` `tests/unit/e11-silent-room-window-real-client.test.ts`

## 2. Gate (run on the tree committed as `ccd12b0`)
- `npm run typecheck` → exit 0.
- `npm test` → exit 1: `Test Files 4 failed | 105 passed (109)`, `Tests 4 failed | 2527 passed | 94 skipped (2625)`.
  The 4 are the Docker `REQUIRED PROOF` guards: `c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored`,
  `s1-fix2-migrations`. **Those suites did not run.**
- `ETA_ALLOW_SKIP_E2E=1 npm test` → exit 0: `Tests 2531 passed | 94 skipped (2625)`. Waived by V.
- `npm run build` → exit 0.
- `npm run check:silent` → exit 1: `Found 9 silent-failure handler(s)`, the accepted 9, none in changed files.
- `swift build --package-path apps/room-recorder` → `Build complete!`.
- `swift test --package-path apps/room-recorder` → exit 1, and **the test target does not build**:
  `external macro implementation type 'TestingMacros.ExpectMacro' could not be found … plugin for module 'TestingMacros' not found`,
  then `error: Build failed`. Waived by V (ruling §1 Q1). The first full run of the E11 round built and ran 600 tests.
- The two E11 files alone → `Test Files 2 passed (2)`, `Tests 34 passed (34)`.

## 3. Files changed (`git show --stat ccd12b0`)
```
 lib/stt/room-drain.ts                              |   3 +
 .../e11-silent-room-window-real-client.test.ts     | 199 +++++++++++++++++++++
 tests/unit/e11-silent-room-window.test.ts          | 144 ++++++++++++---
 3 files changed, 318 insertions(+), 28 deletions(-)
```
Nothing outside these three moved. `git status --porcelain -- apps` is empty, and the untracked `docs/handoff/` files are untouched.

**What each item is:**
- **(a)** A new file drives the `room_window` job through the **real** `lib/whisper.ts`; only `fetch` is faked.
  - `@/lib/whisper` is wrapped as a pass-through that records the client's real answers.
  - It covers 8 server answers: a 200 with empty text; a 500 with body `empty_transcript`; a 500 with prose; a 404 with
    an empty body; a 200 whose body is not JSON; no answer (timeout); `fetch` throwing; no `WHISPER_BASE_URL`.
  - A capture test proves the scenarios produce every producer in the client (`whisper_base_url_missing`, `http_`,
    `timeout_`, `network: `, the constant). Only one answer is the bare constant, and at least one other error
    contains it.
  - The room path is silent only when the client said exactly the constant. Otherwise the job fails
    `whisper_unavailable`, with `last_error` equal to `whisper_unavailable: <the client's own error>`, 1 attempt, 0 cues.
  - Six near misses are derived from the constant, plus a control. They exist to fail `startsWith`, `endsWith` and case folding.
  - The hand-typed `http_502` fixture is removed.
- **(b)** With a silent read, the brain answers the silence batch with `complete:false` / `brain_timeout`. The job fails
  `cues_refused`, with 1 attempt, `last_error` `cues_refused: brain_timeout`, window `closed`, subject not `done`, and no engine.
- **(c)** `room-drain.ts`: the speech branch's `next_progress` states `silent_window: false`. The test enters `segment`
  with a stale `silent_window: true` on a spoken window; the result is `next → engine`, with the flag `false`.
- **(d)** The sweep now counts call sites.
  - It scans every tracked file in `lib app scripts services components`.
  - Five signals: `transcribeWithWhisper`, `whisperAdapter`, `adapterFor(`, `/inference`, `WHISPER_BASE_URL`.
  - Block and line comments are stripped, and an exact count per (file, signal) must equal 20 classified entries,
    each with a role and a reason.
  - A second test requires the window readers in that table to equal the behavioural rows.
  - `adapterFor(` is beyond the Refuter's list: the registry reaches the Whisper adapter by key.

**Mutation check, rerun on both files: 20 of 20 caught.** Each mutation was applied by exact string, run against both
files, and restored with a sha256 match. Each probe file was removed.

| Mutation | Tests failed |
|---|---|
| `===` → `.includes()` (M1 / Refuter R1) | 7 — including the real client's `500, body empty_transcript` and `200, body is not JSON` |
| → `.startsWith()` (R2) | 3 |
| → `.endsWith()` | 3 |
| → case-folded `===` | 1 |
| → `!full.ok` (M2) | 18 |
| attempt consumed on the silent branch (M3) | 3 |
| silent `cueWriteFailed` check removed (R3) | 1 |
| (c) `silent_window: false` removed | 1 |
| kind never skips engine (M4) | 6 |
| `silent_window: true` not set (M5) | 6 |
| marker `segmentCount` 0 → 1 (M6) | 1 |
| silent branch removed (M7) | 7 |
| sync-tool K5 branch removed (M8) | 1 |
| `transcribe_range` K5 branch removed (M9) | 1 |

The six sweep evasions each failed the sweep test (1 test each): a new `lib/` caller; a reader via `whisperAdapter`; a
new call inside the classified `measure-job.ts`; a caller under `services/`; a direct POST to
`${WHISPER_BASE_URL}/inference`; a reader via `adapterFor("whisper")`.

## 4. SQL and external-schema assumptions
No SQL string was added or changed. The tests' fake database matches on statement text that already exists in
`room-drain.ts` (`SET attempts = attempts + 1`, `UPDATE stt_subject_job SET state = 'done'`). `last_error` is read as
`recordFailure`'s first bound value, which is its position in the existing statement.

## 5. Deviations and flags
- **F1 — `adapterFor(` added to the sweep** beyond the Refuter's specification (reason in §3 (d)).
- **F2 — near misses are constructed, not client output.** The real client cannot emit an error that starts with the
  constant today, so `startsWith` cannot be killed from real output alone. They are derived from the constant and
  labelled as such in the file.
- **F3 — the sweep still has blind spots:**
  - it counts text, not calls;
  - a reader built by string-joining a URL, or reaching Whisper through a new wrapper module that imports none of the
    five names, would pass;
  - `.py` / `.sh` files are scanned for `WHISPER_BASE_URL` and `/inference` but hold none today.

  The ruled shared-classifier round is what closes these.
- **F4 — the real-client file shortens exactly three timer durations**: the retry backoff, 90 s and 180 s. Nothing else
  is shortened, so vitest's own timers are untouched.
- **F5 — `swift test` does not build its test target.** The break appeared from my filtered re-run in the E11 round
  onward. Left for tomorrow, per ruling §1 Q3.
- **F6 — the 4 Docker suites remain UNRUN, not green** (rule 8).

## 6. Manual steps for V
- None to run. **A short Refuter pass on `ccd12b0` before merge** (ruling §1 Q2). The sha256 pins are in §1.
- Tomorrow (carryover): clear and rebuild `apps/room-recorder/.build` when no other pane is using it, then rerun `swift test`.

## 7. Subagents
None.
