# ETA — S1 FIX3b — REFUTER BRIEF
**14 September 2026 · Session: `ETA-Refuter` · Mac Mini · `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` · branch `vinay/s1-auto-drain`**
**Revised 10:45 after reading the Builder's report. R7 and R8 changed; R12 and R13 added.**

## 0. Timing

The `scribe` and `scribe3` sessions are both idle and no test process is running. You have the machine.
Do not start a second test process yourself; run everything serially.

## 1. Goal

Refute the FIX3b build. You did not write it, so you owe it nothing. **Rerun every test yourself** — a
green line quoted in the Builder's report is a claim, not evidence. Verdict is PASS or FAIL per item, each
with the command and its decisive output.

## 2. Scope

Read-only on source **except** where this brief tells you to mutate and restore. Create files only under
`docs/handoff/`. **Do not commit, push or amend.** Finish with `git status --short` and quote it.

## 3. Known facts

- Base `8ac9e24`; FIX3b is one commit on top, on `vinay/s1-auto-drain`, not pushed.
- Contract: `ETA-S1-FIX3b-CC-KICKOFF-14-SEP-2026.md` including its ADDENDUM (C15).
- Rulings: `ETA-S1-ROUND4-RULINGS-14-SEP-2026.md`.
- Builder's report: `ETA-S1-FIX3b-REPORT-14-SEP-2026.md`. It claims 43 of 43 mutations failed a test.
- C11–C14 answer H1, H3, H5, H4 of your own `ETA-S1-FIX2-REFUTER-VERDICT-14-SEP-2026.md`.
- The first gate run was RED (five C3 emotion tests) and the Builder reshaped its own SQL rather than the
  harness. Check that the reshape is semantically equivalent, not merely harness-pleasing.

## 4. What to verify

**R1 — the diff is the contract and nothing more.** `git diff --stat 8ac9e24..HEAD`. Every touched file
must be on the edit list; every file on the UNTOUCHED list must show zero changes —
`tests/unit/c2-e2e-runner.test.ts`, `lib/stt/room-drain.ts`, `lib/bench-window.ts`, `lib/stt/fanout.ts`,
`lib/emotion/enqueue.ts`, `lib/emotion/client.ts`, `lib/mcp/**`, `lib/stt/adapters/**`,
`lib/jobs/{runner,store,submit}.ts`, `db/migrations/**`, `vercel.json`, `apps/**`, `package.json`,
`tests/support/pg-harness.ts`, `docs/handoff/scratch/**`, `tests/unit/no-real-clinician-ids.test.ts`.
A file on neither list is a FAIL on its own.

**R2 — the gate, rerun by you.** `npx tsc --noEmit`, then the full suite, serially. Quote exit codes and
counts. Also rerun `npm run build` and `npm run check:silent`. **`check:silent` exits 1 by design** — so
confirm the handler count is still exactly **9** and that none of the 9 sits in a file this round touched.
A tenth handler hiding behind an expected non-zero exit is a finding.

**R3 — C8, the selector.** Confirm the Transcript filter is in the join, applied **before** the `LIMIT`,
reading `room.transcript_enabled` directly. Confirm an unknown room fails closed by dropping out of the
join. Mutate: drop the condition, confirm a test fails, restore, `cmp`.

**R4 — C9, write-iff-changed.** Three arms: stored row `failed`, older `diarize_run_id`, or the six-tuple
`IS DISTINCT FROM`. Run the two paired assertions (identical re-run writes nothing; differing re-run
rewrites). Confirm `c2-e2e-runner.test.ts:1351-1359` IDEMPOTENT is byte-identical to `8ac9e24` and passes.

**R5 — C10, null vs counts.** Confirm the four `fail()` sites that run before this attempt's delete, plus
the two catch paths, record NULL; and only the later sites derive counts from `room_span_emotion`. A count
carried from an earlier attempt's rows is a FAIL.

**R6 — C11, the guard over the staged tree.** The Builder proved this with `tests/unit/s1-guard-staged.test.ts`
in a throwaway repo. Run it, then prove it again in **this** repo, independently:
1. Create a new markdown file under `docs/handoff/`, put one id-shaped token in it, run the guard while it
   is untracked — it should pass (the exemption). `git add` it, run the guard — it must **fail and name the
   file**. Then `git rm --cached` it and delete it.
2. Control (rule 7): with the file gone, the guard passes. A guard that always fails proves nothing.
3. **Never print the token.** Name the file and the count only — the guard's own line 68 says so.
4. Confirm `ETA-S1-FIX2-REPORT-14-SEP-2026.md` shows exactly `1 1` on `git diff --numstat`, one hunk, and
   that its placeholder can no longer match the shape.

**R7 — C15.1: verify the Builder's F1 refusal, do not verify an edit.** *The Orchestrator's C15 premise was
wrong.* The addendum assumed the two tokens in `docs/handoff/scratch/C2-REFUTER-NOTES.md` could not be
confirmed synthetic. The Builder reports they are **already on `SYNTHETIC_CLINICIAN_IDS`**, so the guard
never flagged them and no edit was owed. Your job is to test that refusal, not the edit:
1. Confirm `docs/handoff/scratch/C2-REFUTER-NOTES.md` is byte-identical to `8ac9e24`.
2. Confirm `tests/unit/no-real-clinician-ids.test.ts` is byte-identical to `8ac9e24` — no allowlist entry
   added, `CLINICIAN_ID_SHAPE` and `unlistedIds` untouched.
3. Confirm mechanically that `unlistedIds` returns **0** for that file, and that both its tokens are on the
   allowlist. Do not print them.
4. **Re-prove the standing invariant:** every entry in `SYNTHETIC_CLINICIAN_IDS` itself matches
   `CLINICIAN_ID_SHAPE`. Assert it in code, not by eye. An entry that does not match is dead weight that
   can hide a real id behind a passing suite.
If any of 1–4 fails, the Builder's F1 is wrong and C15.1 is still owed.

**R8 — C12, the harness, and the bug that was left standing.**
1. In `tests/support/s1-pg.ts`, feed a statement starting with a comment, one starting with `(`, one with
   `VALUES`, one with `TABLE`. Each must throw `UnrecognisedStatementError`. A zero-row return is a FAIL.
2. Confirm the header comment names both unfixed divergences (bigint-as-number; row order not guaranteed).
3. **The third bug:** confirm `s1-pg.ts` now finds a `WITH … INSERT … SELECT` statement's main verb as the
   **first** top-level SELECT/INSERT/UPDATE/DELETE, not the last SELECT.
4. **F3 — measure the exposure, do not fix it.** `tests/support/pg-harness.ts` still has that bug and is on
   the untouched list. Confirm it is unedited, then demonstrate the bug there with a throwaway statement so
   we know the failure is real and not theoretical. Report how many existing statements in the repo start
   with `WITH`. **Do not edit `pg-harness.ts`.**

**R9 — C13, order independence.** Run `ETA_S1_REVERSE_ORDER=1` over the zero-scored retry file yourself.

**R10 — C14, the real JWT.** Confirm `vi.mock("@/lib/auth")` is gone, the success test mints through the
repo's own signing path, and the real `verifyAdminJwt` verifies it. Mutate: corrupt one byte of the test's
signing secret and confirm the test fails. Restore. Confirm all four negatives still pass. Note for the
record whether the still-mocked cookie read weakens the test, and say why or why not.

**R11 — mutations, sampled.** Do not rerun all 43. Reproduce **six** yourself, chosen to include:
`ROOM_AUTO_DRAIN_ENABLED` misspelt (claimed 32), the C9 `failed`-arm removal (claimed 1), the C11
staged-copy read removal (claimed 2), the C12 `WITH … INSERT` misclassification (claimed 1), the C14
signature-verification removal (claimed 1), and one clamp-bound change of your choice. A claimed count you
cannot reproduce is a finding; restore and `cmp` after each.

**R12 — F2: adjudicate the Builder's correction of the ruling.** The Builder says the round-4 ruling's
premise — *"the job runner keeps its own attempt counter, so no retry ceiling depends on the window's"* —
is **inaccurate**, because `lib/emotion/enqueue.ts:63` re-queues only while
`room_emotion_window.attempts < EMOTION_MAX_ATTEMPTS`, so a strict write-iff-changed rule would never
increment `attempts` and the retry bound would never trip. This is load-bearing and it is a correction to
the Orchestrator, so verify it independently:
1. Read `lib/emotion/enqueue.ts` around `:63` and state which table and column that bound actually reads.
2. If the Builder is right, confirm the `failed` arm is the minimum fix — not a broader always-write.
3. If the Builder is wrong, say so: the `failed` arm would then be an unnecessary write on every retry of a
   failed window, and the ruling stands as written.
Report which, with the line quoted. **Do not change the code either way.**

**R13 — F5: is the pre-delete failure record honest or stale?** On a re-run of a settled `ok` window whose
`/health` fails, the window row is written `failed` with NULL counts while the **earlier** attempt's
`scored` segment rows remain, because the delete has not run. Reproduce this state and describe exactly
what a reader of `room_emotion_window` joined to `room_span_emotion` would see. State whether any consumer
in the repo reads that pair and would be misled. This is an Orchestrator decision — **report, do not fix.**

## 5. What NOT to do

Do not fix anything. Do not improve anything you dislike. Do not edit `pg-harness.ts`. Do not run two test
processes at once. Do not commit, push or amend. Never reproduce the banned id shape in your verdict, in a
quoted command, or in any file you create. Env var **NAMES only, never values**.

## 6. Output

Write `docs/handoff/ETA-S1-FIX3b-REFUTER-VERDICT-14-SEP-2026.md`:
- One line: **PASS** or **FAIL** overall.
- R1–R13, each with verdict, command, decisive output. A few lines each; long logs go to
  `docs/handoff/scratch/` and are cited by path.
- **H1–H5 from your FIX2 verdict: closed or not closed**, one line each.
- Anything outside the contract — state it, do not act on it.
- Final `git status --short`, quoted.

**Cap: 160 lines.** Overflow to scratch.
