# ETA — S1 FIX4 — REFUTER DELTA BRIEF
**14 September 2026 · Session: `ETA-Refuter` · branch `vinay/s1-auto-drain` · this is a DELTA, not a re-review**

## 0. Timing and scope

`scribe` and `scribe3` are both idle; no test process is running. You have the machine. Run serially.

**This is not FIX3b again.** Your own verdict on FIX3b stands: R1–R13 passed, H1–H5 closed. FIX4 answers
exactly one finding — your X1 — plus two report-only questions. **Review only the delta.** Do not re-run
R3, R5–R11; they cover code this round did not touch. Do re-run the full gate, because a widened
comparison can break something far away.

## 1. Known facts

- FIX4 commits on top of `6067ba8`. The ruling on X1 is in `ETA-S1-FIX4-CC-KICKOFF-14-SEP-2026.md` §1–§2.
- C16 added five fields to the conflict `WHERE` in **both** upserts: `model`, `model_key`, `subfolder`,
  `cap_s`, `room_day_id`. Excluded, with reasons required in a comment: `calls`, `warmup_json`,
  `timing_json` (per-run telemetry, no segment counterpart), `scored_at`, `attempts`, `failure_history`
  (write bookkeeping), `diarize_run_id` (already its own arm).
- The Builder reports five mutations, one per added field, each turning a test red: `model` 1,
  `model_key` 1, `subfolder` 1, `cap_s` 2, `room_day_id` 1.
- C17 answered: `room_span_emotion` carries all five per row, so `cap_s` is inside G2's scope; and the
  emotion service reads its cap once at process start and never reassigns it, so it cannot jitter.
- C18 answered: nothing runs the tests automatically. `ci.yml` fires only on push/PR to `main`, `main` is
  unprotected with no required checks or rulesets, Vercel runs `next build` only, and there are no git
  hooks. Treat "the suite is green on this machine" as the only evidence that exists.

## 2. What to verify

**D1 — the diff is the delta.** `git diff --stat 6067ba8..HEAD`. Only `lib/emotion/store.ts` and the S1
test files, plus the two bus documents named in kickoff §7. Everything on kickoff §6's UNTOUCHED list at
zero — `c2-e2e-runner.test.ts`, `pg-harness.ts`, `repo-files.ts`, `s1-pg.ts`, `no-real-clinician-ids.test.ts`,
`auto-drain.ts`, `emotion-window.ts`, `db/migrations/**`, `vercel.json`, `apps/**`, `package.json`.

**D2 — the gate, rerun by you.** `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run check:silent`
(expect exit 1, **exactly 9** handlers, none in a touched file). Quote counts.

**D3 — X1 is actually closed.** Reproduce your own X1 probe against HEAD: same `diarize_run_id`, identical
counts, model and subfolder changed. The window row must now be rewritten and must agree with its segment
rows. This is the finding that made FIX3b a FAIL; prove it is gone, with the same probe, not a new one.

**D4 — C9 is still alive.** A genuinely identical re-run of a settled `ok` window still writes nothing:
`scored_at` and `attempts` both unmoved. Without this, FIX4 has "fixed" X1 by making every re-run a write.

**D5 — `cap_s` NULL handling.** `IS DISTINCT FROM` on a widened row constructor must still treat
NULL-against-value as a difference in **both** directions, and NULL-against-NULL and value-against-same-value
as no difference. `cap_s` is nullable `double precision` and the `fail("none")` path writes NULLs, so this
is where a widened tuple most plausibly goes wrong.

**D6 — IDEMPOTENT.** `c2-e2e-runner.test.ts:1351-1359` byte-identical to `8ac9e24` and green in the full
run. You expected the widened tuple to keep it green but did not test it; now it is testable.

**D7 — the five mutations, reproduced.** All five, by you. One field removed at a time. The Builder's own
insight is the trap to check: removing `model` **or** `subfolder` alone left his X1 case green because the
other still triggered the rewrite, so each field needs a case that isolates it. Confirm each of the five
counts, restore, `cmp`.

**D8 — adjudicate F1, the Builder's flag on my own ruling.** He reports that comparing `model_key` cannot
keep the window row in step, because `finish()` writes the **constant** `EMOTION_MODEL_KEY` while segment
rows store the key the service actually reported — so the compared value can never differ, and the field is
inert. Verify independently: name the line that writes the constant, name the line that writes the segment
row's key, and state whether the two can ever disagree today. **If he is right, say so plainly** — I have
ruled that `model_key` stays in the comparison with a comment marking it inert until the write is fixed,
and the fix is queued outside this round. What I need from you is whether the inertness claim is true, and
whether the comment in the code says so accurately. **Do not change the code.**

**D9 — F2, stated only.** He reports `device` is stored per segment row with no column in the window table.
Confirm or correct in one line. No action.

## 3. What NOT to do

Do not re-review FIX3b. Do not fix anything, including the `finish()` constant. Do not touch
`pg-harness.ts` or `c2-e2e-runner.test.ts`. Do not commit, push or amend. Never reproduce the banned id
shape. Env var **NAMES only, never values**. Do not run two test processes at once.

## 4. Output

`docs/handoff/ETA-S1-FIX4-REFUTER-VERDICT-14-SEP-2026.md`. **Cap: 90 lines.** Long logs to
`docs/handoff/scratch/`, cited by path.

- One line: **PASS** or **FAIL**.
- D1–D9, each with verdict, command, decisive output.
- **X1: closed or not closed**, stated on its own line.
- Anything new you find outside the delta — state it, do not act on it.
- Final `git status --short`, quoted.
