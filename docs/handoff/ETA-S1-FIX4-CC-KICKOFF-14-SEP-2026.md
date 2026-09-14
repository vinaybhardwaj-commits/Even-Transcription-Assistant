# ETA — S1 FIX4 — CC KICKOFF (X1: close the hole in C9)
**14 September 2026 · Session: `scribe` · branch `vinay/s1-auto-drain`, NEW COMMIT on `6067ba8`.**

Read `docs/handoff/ETA-S1-FIX3b-REFUTER-VERDICT-14-SEP-2026.md` first. It is a **FAIL**, on one finding
(X1). R1–R13 all passed and your F1, F2 and F3 flags were all upheld — F2 in particular corrected a ruling
of mine against the code, which is the loop working. This round is small.

## 0. Machine, repo, branch, push policy

Mac Mini · `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` · branch `vinay/s1-auto-drain` at
`6067ba8`. **Commit on the branch. DO NOT push. DO NOT touch `main`. Never amend `6067ba8`.**

## 1. The ruling on X1

The Refuter found that C9's six-tuple omits `model`, `model_key`, `subfolder` and `cap_s`. An emotion model
change followed by a same-run re-score leaves the window row naming the **old** model and subfolder while
both segment rows carry the **new** ones, with `scored_at` unmoved. Round 3's **G2** — *"no path may leave
the window row stale relative to its segments"* — forbids exactly that, and C9 exists to enforce G2. The
finding stands. **My six-tuple was wrong; it is not that the rule is too strict.**

**The principle, which is what generalises: the comparison covers everything the segment rows can
contradict, plus the identifying facts of the run that produced them. Per-run telemetry with no segment
counterpart stays out.** That line is why `calls` and `timing_json` are excluded and `model` is not — not
taste. Your own F4 supplies the reason `calls` is out: no row records it, so no row can contradict it.

## 2. C16 — extend the comparison in both upserts

`lib/emotion/store.ts`, the conflict `WHERE` in `recordEmotionWindow` (`:156-160`) and
`finishEmotionWindow` (`:248-252`). Add to the compared tuple:

`model` · `model_key` · `subfolder` · `cap_s` · `room_day_id`

Keeping the existing six (`state`, `error`, `segments_planned`, `segments_scored`, `segments_skipped`,
`segments_failed`) and the two standalone arms (`state = 'failed'`, `diarize_run_id <>`) exactly as they are.

**Explicitly OUT, and say so in a comment at the tuple naming each and its reason:**
`calls`, `warmup_json`, `timing_json` (per-run telemetry, no segment counterpart, would rewrite on every
re-run and destroy C9) · `scored_at`, `attempts`, `failure_history` (write bookkeeping, derived from the
write itself) · `diarize_run_id` (already its own arm).

**Watch the NULL comparison.** `IS DISTINCT FROM` on the row constructor is what makes NULL-vs-value a
difference; `cap_s` is `double precision` and nullable, and the `fail("none")` path writes NULLs. Confirm
the operator still behaves that way once the tuple widens, and say so with the test that proves it.

## 3. Tests (rule 7 applies: every refusal paired with a control)

1. **The X1 case, as the Refuter reproduced it:** same `diarize_run_id`, identical counts, model and
   subfolder changed → the window row **is rewritten** and now names the new model.
2. **The control that keeps C9 alive:** a genuinely identical re-run of a settled `ok` window still writes
   nothing — `scored_at` and `attempts` both unmoved.
3. **`c2-e2e-runner.test.ts:1351-1359` IDEMPOTENT stays green and that file stays UNTOUCHED.** The Refuter
   expected the widened tuple to keep it green but did not test it. Prove it.
4. **A `cap_s` NULL↔value transition is a difference** — one case, with its control.
5. **Mutation check: one per added field.** Remove each of the five from the tuple in turn, confirm a test
   fails, restore, `cmp`. Report the five counts.

## 4. C17 — report only, change nothing

Does `room_span_emotion` carry `model`, `model_key`, `subfolder` and `cap_s` per row? Answer per column.
This decides whether `cap_s` is inside G2's scope or merely a fact about the run; either way it stays in
the tuple this round, but I want the answer on the record.

Second question, same treatment: **is `cap_s` stable across runs**, or can the emotion service report a
different cap between two calls with no configuration change? If it can jitter, including it would turn an
idempotent re-run into a rewrite — say so plainly and I will rule again rather than have you work around it.

## 5. C18 — report only, change nothing

**Is `npm test` run automatically anywhere on a push, a PR or a Vercel build — or only when a person runs
it locally?** Answer from configuration you can read, and mark it UNVERIFIED if you cannot find a definite
answer. Do not create any CI. This answers the one residual the Refuter left on H1: the id guard scans the
staged tree, but nothing enforces that the gate ran after staging, so a bus document committed after a
local gate still escapes. I am not fixing that this round; I want to know whether a second net exists.

## 6. File contract

**Edit:** `lib/emotion/store.ts` · the S1 test files.
**UNTOUCHED:** `tests/unit/c2-e2e-runner.test.ts` · `tests/support/pg-harness.ts` (its `WITH … INSERT`
bug is logged as debt, not this round's work) · `tests/support/repo-files.ts` · `tests/support/s1-pg.ts` ·
`tests/unit/no-real-clinician-ids.test.ts` · `docs/handoff/scratch/**` · `lib/stt/auto-drain.ts` ·
`lib/jobs/kinds/emotion-window.ts` · `lib/stt/room-drain.ts` · `lib/bench-window.ts` · `lib/stt/fanout.ts` ·
`lib/emotion/{enqueue,client}.ts` · `lib/mcp/**` · `lib/stt/adapters/**` ·
`lib/jobs/{runner,store,submit}.ts` · `db/migrations/**` · `vercel.json` · `apps/**` · `package.json`.

## 7. Gate and report

`npx tsc --noEmit`, `npm test`, `npm run build`, all quoted. `npm run check:silent` will exit 1 with
**9** handlers — quote the count and confirm none is in a file you touched; a tenth is a stop.
**Stage every file this commit carries BEFORE you run the gate** — that is still C11's whole point and the
Refuter confirmed nothing enforces it for you.

Report to `docs/handoff/ETA-S1-FIX4-REPORT-14-SEP-2026.md`: new sha · gate output ·
`git diff --stat 6067ba8..HEAD` · the changed SQL verbatim · the five mutation counts · C17 and C18
answers · flags. Commit this kickoff and the FIX3b Refuter verdict by exact filename alongside your report;
**do not `git add .`**. Env var NAMES only. Never reproduce the banned id shape.

## 8. Known facts

- Repo is at `6067ba8`; the Refuter made no commits and left only untracked files.
- `diarize_run_id` is NOT NULL since migration 0089.
- The Refuter's probe harness is `docs/handoff/scratch/FIX3b-REFUTER-probe.{test,vitest.config}.mts`; the
  `.mts` extension deliberately keeps it outside both tsconfigs. Reuse it if it helps; do not adopt it into
  the suite.
- Known debt, **not this round**: `pg-harness.ts` splits `WITH … INSERT … SELECT` at the last top-level
  SELECT (8 `WITH` statements in `lib/`, 0 with the breaking shape today — real but latent); and the
  `c2-e2e-runner` IDEMPOTENT tests fail when filtered alone, identically at `8ac9e24`, so that order
  dependence predates this work.
