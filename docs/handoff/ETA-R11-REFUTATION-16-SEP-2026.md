# ETA-R11 — Refutation of 8ee8d29 (0100, the R11 plan test, the R12 comment) · 16 Sep 2026 · Refuter (Builder pane)

Branch `vinay/s1-auto-drain`, head `8ee8d29`. Everything ran in a `git archive` copy under the session scratchpad; I
did not enter main. Nothing was fixed, committed, pushed or merged. 0100 was applied only inside ephemeral
postgres:16 containers (the suite's own, and two of my own probes). Per R22 I do not treat the missing live row count
or live EXPLAIN as findings. Process inspection: none.

## 1. Verdict — MERGE-READY. The branch is clear for production promotion.

8ee8d29 was the last unrefuted commit. Its migration, its plan test and its R12 comment all hold up, and the R12
number is right when I measure it myself. Two conditions that are already on the record, not new findings: 0100 is
committed but unapplied, and R22's live EXPLAIN plus `count(*)` are owed at apply time. One open item stays outside
this diff: `swift test` fails by name (E22 R23), which touches no web code and no Vercel deploy.

## 2. Priority 1 — is the tightened plan test strong, or did it move the goalposts?

**Strong. I tried to get a wrong index past it and could not.** Every index-shape mutant is caught (§5): the partial
predicate dropped (R11-1), the index moved to `closed_at` (R11-2), a composite `(auto_drain_refused_at, id)`, `DESC`,
`INCLUDE (id)`, a renamed index, and a predicate narrower than the query's. It also protects the *query*: rewriting
the shipped branch as `COALESCE(rw.auto_drain_refused_at, …) >=` or `date_trunc('hour', …) >=` — both of which leave
the index unusable — fails it. Naming an index would not have caught one of these; the Index Cond does.

**What it still cannot see, and this is the honest limit.** The assertion runs with `enable_seqscan = off`, so it
proves the index *can* serve the predicate, not that the planner *would* choose it. I built the case where the index
is usable but worthless — every row refused inside the horizon, so a sequential scan is the right plan:

```
REFUTER P3 planner's real choice (seqscan on): SEQ SCAN — the index is not worth using
REFUTER P3 the repo's assertion (seqscan off) still passes: true
```

So a future world in which this index stops being worth its write cost passes the test unchanged. That is exactly the
hole R22's owed live EXPLAIN fills, and 0100's header already owes it. Recorded as a limit, not a defect.

**One brittleness, the other way.** The `pg_indexes` assertion pins the definition string exactly, anchored at `$`.
`INCLUDE (id)` — an index that would serve this branch as well or better — fails it (mutant M6). A later improvement
will read as a regression until someone edits the regex.

## 3. Priority 2 — does the partial predicate match the query's?

**Yes, and the direction is the safe one.** The branch's predicate is `auto_drain_refused_at >= NOW() - 6h`, which is
never true for NULL, so the planner proves the index's `WHERE auto_drain_refused_at IS NOT NULL` and may use it. The
index predicate is deliberately **wider** than the query's (all non-null refusals, not just the horizon): a horizon
predicate cannot be indexed, since `NOW()` is not immutable. Wider costs size, not correctness, and the size is
bounded by refusals ever recorded, not by `bench_window` — 64 kB against a 12 MB table in the commit's own figures.
A **narrower** predicate is the failure the brief names, and mutant M4 (`AND state = 'closed'`) is caught.

I measured two things the repo's test does not:

- **P1 — with seq scans ENABLED** on a production-shaped table (60,000 windows, 1,200 ever refused, 7 inside the
  horizon), the planner chooses it on its own: `Index Scan using idx_bench_window_auto_drain_refused_at`,
  `Index Cond: (auto_drain_refused_at >= (now() - '06:00:00'::interval))`, `Buffers: shared hit=7`.
- **P2 — the PARAMETERIZED form the driver actually sends.** The shipped SQL interpolates `${AUTO_DRAIN_MAX_AGE_HOURS}`
  as a **bound parameter**; the repo's test substitutes a literal before planning. Under `force_generic_plan` with a
  real `PREPARE`, the index is still chosen:
  `Index Cond: (auto_drain_refused_at >= (now() - (($1)::double precision * '01:00:00'::interval)))`.
  **The repo's test would not have seen a regression that only affects the parameterized plan.** It does now, in this
  report, but not in CI.
- **P4 — the whole selector, not just the branch.** With 0100 applied there is no sequential scan left anywhere in the
  tick's query: the main scan rides 0057's `idx_bench_window_state`, the refusal branch rides 0100, the job half rides
  `scribe_job_status_created_idx`. Drop 0100 in the same container and the refusal branch returns to
  `Seq Scan on bench_window rw (cost=0.00..1908.00)`. My fixture left that branch `never executed`, so my timings say
  nothing about runtime; the plan shape is the result, and the commit's own 4.888 ms → 0.169 ms covers the timing.

## 4. Priority 3 — the R12 comment's number, measured by me

The comment claims `tests/unit/e17-drain-fairness.test.ts` is 30 of 30 green against the pre-fix commit. I put
`3aa75c9`'s `lib/stt/auto-drain.ts` into the scratch copy and ran that file alone:

```
Test Files  1 passed (1)
Tests  30 passed (30)
```

**Confirmed, exactly as written.** The file cannot see F1 come back, the Postgres S2 test can, and the comment now
says so where a pruner will read it.

## 5. Priority 4 — mutation check: 12 caught of 12 run

Per mutant: `s1-auto-drain` and `e17-drain-fairness` (Docker up, postgres:16). Each mutation was applied by an exact
string matched once and restored under a sha256 check.

**Caught (12):** R11-1 partial predicate dropped · R11-2 index on `closed_at` · M3 composite · M4 predicate narrower
than the query's · M5 `DESC` · M6 `INCLUDE (id)` · M7 `IF NOT EXISTS` dropped (the double apply errors the suite) ·
M9 renamed index · M10 branch wrapped in `COALESCE` · M11 branch wrapped in `date_trunc` · M12 branch horizon becomes
`>` · **M8 the `schema_migrations` row removed.**

**M8 needs its scope stated.** It SURVIVED my two-file set, because both suites strip that INSERT with `noRecord()`.
It is caught by `tests/unit/migrations-self-record.test.ts`, which I then ran against the same mutant:
`Tests 1 failed | 94 passed (95)`, failing on "0100 … records itself with its own version and its own name". So the
repo catches it; my first scope did not. No equivalents. No survivors.

**R11-1 and R11-2 — the two that survived scribe3's first run — are dead, and I killed them myself rather than taking
the commit message's word.**

## 6. Gate, rerun by me in the copy

`npm run typecheck` exit 0 · `npm test` `Test Files 111 passed (111)`, `Tests 2677 passed (2677)`, Docker up, no skip
variable · `npm run build` exit 0 · `npm run check:silent` exit 1 with the accepted pre-existing 9.

## 7. Findings

- The tightened plan test is genuinely strong: it kills both first-run survivors, every index-shape mutant I could build, and two rewrites of the shipped query.
- It proves usability, not usefulness: with `enable_seqscan=off` it passes even where the planner would never choose the index (probe P3). R22's owed live EXPLAIN is the only thing that closes this.
- The `pg_indexes` pin is exact to the point of brittleness: `INCLUDE (id)`, a harmless improvement, fails it.
- The partial predicate is implied by the query's and deliberately wider; a narrower one is caught (M4).
- The repo's test plans a LITERAL horizon; production sends a bound parameter. I proved the parameterized plan uses the index; CI does not check it.
- With 0100 the whole tick selector has no sequential scan left; without it the refusal branch is a seq scan on `bench_window`.
- R12's "30 of 30 green against 3aa75c9" is correct, measured.
- M8 is caught only by `migrations-self-record.test.ts` — a reminder that a mutation set is only as wide as the suites it runs.

## 8. Anything unrun
- **`swift test`: not run.** R26 says run it alone and scribe may be running one; this diff changes no Swift, and the
  branch already carries its failure as a named open item (E22 R23). R27 noted: I did not run `swift build` either,
  and would not have read it as evidence about the tests.
- **0100 is not applied anywhere but ephemeral containers**, as ordered. The live `count(*)` and post-apply EXPLAIN
  remain owed at apply time (R22).
- My P4 timings are not a runtime comparison: the refusal branch was `never executed` in that fixture.

## 9. Scratch evidence (session scratchpad, not committed)
`r11/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `mutate.mjs`, `mutation-results.json`, and the two
probe files `tests/unit/zz-refuter-r11.test.ts` (P1–P3) and `tests/unit/zz-refuter-r11b.test.ts` (P4), which exist
only in the scratch copy.

## 10. Subagents
None.
