# ETA — overnight canary + bounded retry. REFUTER RE-CHECK. 21 Sep 2026

`vinay/overnight-translate` **`dcf7f9a` → `579dbb4`** (builder scribe3), two commits, 3 source files + 3 test files, **no migration**. Own detached worktrees `/tmp/refute-ot2` and `/tmp/refute-ot2-mut`; builder's worktree never written to, nothing pushed, the driver never started. Re-checked only the four items named.

## PASS — with two test-coverage gaps, both one line each

**Mutations: 6 of 8 killed** (one patch miss, re-stated below). Gate fully green.

### 1. The throwing arm now stops at 5, and the windows stay re-pickable — CONFIRMED

Re-ran the exact probe that produced the original flag: 40 candidate windows, no English in either arm.

| English check | before (`dcf7f9a`) | after (`579dbb4`) |
|---|---|---|
| throwing | `done=40 failed=0 stop=backlog_empty` | **`done=0 failed=0 unverified=5 stop=fatal too_many_failures`** |
| working | `done=0 failed=5 stop=fatal` | `done=0 failed=5 stop=fatal` (unchanged) |

An unreadable check now counts toward the same 5-consecutive stop, is never recorded `done`, never resets the counter, and lands in its own `unverified` tally. Mutations Q1 (`english !== "ok"` → `=== "missing"`, i.e. fail open again) and Q2 (reset the counter on the unavailable arm) both die.

The window is left re-pickable because **nothing is written**: an "attempt" is derived, not stored — a count of `done` `room_window` jobs carrying this driver's actor and `translate='true'`. No new column, no migration. The driver also now logs `error_name` only, "the message can carry SQL or connection detail" — the convention I have been asking for elsewhere.

### 2. Attempts capped at 3, no 4th — CONFIRMED, enforced twice

`RETRY_MAX_ATTEMPTS = 3`, applied in two places: `fixtureVerdict` (`>= RETRY_MAX_ATTEMPTS → "skip_parked"`) and the retry scan's own SQL (`… < ${RETRY_MAX_ATTEMPTS}`). Q3 (cap → 4) and Q4 (`>=` → `>` in the verdict) both die.

**Gap A — the SQL half of the bound is not pinned.** Q5 (`< RETRY_MAX_ATTEMPTS` → `<=` in the retry scan) **survives**. Behaviour is unchanged today because the TypeScript verdict catches an attempts-3 row and skips it, so the two guards are belt and braces — but only the belt is tested. If the verdict check were ever removed in favour of "the SQL already does it", nothing would go red.

### 3. The 200-row retry scan cap — PRESENT, and load-bearing today

`retryRows` ends `ORDER BY w.end_ms ASC, w.id ASC LIMIT 200`.

**Gap B — it is not pinned either.** Q6 (delete the `LIMIT 200`) **survives**. This is a closable gap rather than an unkillable one: the test harness already captures statement text and uses it — `overnight-translate-select.test.ts:128` asserts the *backlog* query contains `ORDER BY w.end_ms ASC, w.id ASC LIMIT 1`. The same assertion for the retry scan would kill both Q5 and Q6.

**Measured live** (read-only, `BEGIN READ ONLY`, ids and counts only): 246 bench windows have a run; **211** have text on their newest run and no English — consistent across four formulations, and the `state IN ('closed','transcribed') AND grid_aligned` filters remove none of them. So the eventual retry population is **211 against a 200-row cap**: the cap is load-bearing, not theoretical, and correctness depends on the scan being re-run with a growing `skip` set rather than on one pass. That mechanism is sound (`exclude` only grows within a run, and a window that still has no English is re-picked by a *later* run), but it is doing real work.

I also ran the retry scan itself verbatim against production: **0 rows pickable**, which is right — there are **0** `scribe_job` rows for the actor `overnight-translate`, so there is nothing to retry until the driver has run once. The statement parses and executes against the live schema.

### 4. Nothing else in the branch moved — CONFIRMED

`git diff --name-only dcf7f9a 579dbb4` is exactly `driver.ts`, `main.ts`, `select.ts` and their three test files. Every surface I cleared in the first verdict is **byte-identical**: `lib/jobs/submit.ts`, `lib/jobs/types.ts`, `lib/jobs/kinds/room-window.ts`, `app/api/brain/cues/route.ts`, `lib/mcp/tools/bench.ts`, `lib/stt/room-drain.ts`, `hours.ts`, `gate.ts`, `door.ts`, `scripts/overnight-translate.ts`. The `switch_override` write-scope enforcement, the 07:10 stop, the gates and the door are untouched, and the switch-override suites are in my mutation test set and stayed green throughout.

### One mutation could not be applied

Q8 (drop the "no job queued or running for this window" guard) was a **PATCH-MISS**: the clause appears twice, in `fixtureRows` and `retryRows`. Not run, so not claimed either way.

## Gate, my run

`typecheck` exit 0. `npm test`, clean run with nothing else on the machine: **`Test Files 152 passed (152)`, `Tests 3493 passed | 1 skipped (3494)`**, 311 s — **zero failures**, including `e31b-atomicity R58`. `build` `✓ Compiled successfully in 8.0s`.

**Verdict: PASS.** V's ruling is implemented as written — fail closed, counted, bounded at 3, parked and still counted, with no new state. Gaps A and B are the same missing line of test coverage on the retry scan's SQL text, and the harness already does that for the neighbouring query.
