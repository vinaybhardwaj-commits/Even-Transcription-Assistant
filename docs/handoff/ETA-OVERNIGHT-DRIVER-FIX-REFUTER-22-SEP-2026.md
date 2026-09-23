# ETA — overnight driver fix (foreign cancel, recent-activity skip). REFUTER VERDICT. 22 Sep 2026

`vinay/overnight-translate` **@ `60b3072`** (builder scribe3), base `a3f25ec`. Diff: `lib/overnight-translate/driver.ts` (foreign-cancel branch), `lib/overnight-translate/select.ts` (recent-activity clause in 4 candidate queries), plus tests. Reviewed in my own detached worktree `/tmp/refute-ot3`. The running driver was **not touched** (it is not running). No drainer started. Production DB read-only via `ro_query.py`, counts only.

## FAIL — the fix removes the stop, but puts nothing in its place

Order item (1) is built as written: a `cancelled` terminal is now `window_deferred reason=foreign_cancel`, never a failure, and the window stays re-pickable. But the two failure modes behind today's fatals now **run all night, silently**:

| Probe (local fakes, the real driver loop) | Result |
|---|---|
| A canceller cancels every job we submit | `submits=200 deferred=200 failed=0 done=0 stop=backlog_empty fatal=null` |
| The join service is held all night (`join_already_running`) | `submits=600 windows_exhausted=200 failed=200 done=0 stop=backlog_empty fatal=null` |

Before this change, the 5-consecutive-failure stop was the only signal that exposed the admin-route loop and the direct-SQL canceller. After it, the same night ends as a clean `backlog_empty` with zero `done`.

### FINDING 1 (the FAIL) — no stop for foreign cancels or join contention
Foreign cancels do not advance any counter that can stop the run. Join contention was already kept out of the consecutive-failure count (pre-existing). So a run where nothing succeeds ends normally. **Fix:** a separate consecutive-foreign-cancel limit (e.g. 5 → stop with `fatal=foreign_cancels`), and a stop or back-off on consecutive `join_contention_exhausted`. Any `done` resets both.

### FINDING 2 (high) — contention parks windows permanently
The selector excludes a window once it has `maxFailedJobs` (default **2**, `driver.ts:79`) failed `room_window` jobs, **counted across every submitter** (`select.ts:183, 230, 291`). Production now: **143 windows are already parked** by this rule, **128 of them purely by join contention**, 134 with any contention. The join-held probe above adds 200 `failed` rows in one night. **Fix:** count only this driver's own failures, or leave `join_already_running` and cancelled jobs out of that count. Pin the default with a test (nothing pins it now).

### FINDING 3 (medium) — the recent-activity guard does not prevent join collisions
The new clause skips a window with any job updated in the last 5 minutes. That is **per window**, but the join mutex is **service-wide**: another drainer on a different window still collides. It reduces duplicate work on the same window. It does not do what order item (3) asked for. Mutation F3 (`RECENT_ACTIVITY_MINUTES` 5 → 0) **survives**, so the window length is untested.

### FINDING 4 (low) — a comment is wrong
The new branch says it behaves "exactly like `unverified`". It does not: `unverified` counts toward `consecutiveFailures`, foreign cancel does not.

### FINDING 5 (ops, not the code) — the driver's token is being used by someone else
Three audited `scribe_job_cancel` calls under `mcp:overnight-translate` (17:29:13, 19:47:37, 20:26:54 IST). The driver has **no cancel code** at `60b3072` and was not running at 20:26. So an operator is holding the driver's write-scoped token, and audit attribution for that actor is wrong. Order item (2) is met by the code (the driver has no cancel path at all), but the audit trail cannot show it. **Fix:** rotate the token, and give the operator their own.

## What holds
- Order item (1) as written: correct. Mutations F1 (drop the branch), F2 (count it to the stop), F4 (drop the backlog-query clause), F5 (`updated_at` → `created_at`) all **killed**. 4 of 5.
- Order item (3), night-drain: scribe3 correctly did **not** skip windows night-drain processed. Night-drain diarizes and joins locally; it never calls the join service. The premise in the order was off, not the build.
- **Staged bundle** `~/dev/_fable/scratch/overnight-translate.staged.mjs`: byte-identical to my own esbuild of `60b3072`, after normalising the `node_modules` path in comments.

## Gate
Targeted vitest (`lib/overnight-translate/**`, driver and select): **326 passed**. Mutations 4 of 5 killed; F3 survives.

## Jev — on the diff, none of my findings in its context
Scores 5.6–6.5, all "low", generic issue text.
- **correctness 5.7**, "relies on an unsafe or incorrect assumption" — **consistent** with Finding 1, but not independent proof: the text names nothing.
- **reliability 5.9**, "a race or concurrency assumption" — **consistent** with Finding 3 (per-window guard, service-wide mutex).
- **observability 6.0**, "a credible production failure would not be visible" — **consistent** with Finding 1 (an all-failed night ends `backlog_empty`).
- **changeability 5.8 / duplication 5.9**, "a rule scattered across places" — **confirmed** in a small way: the same clause is pasted into 4 queries.
- **maintainability 5.6, documentation 5.8** — Finding 4 is one concrete case; otherwise not counted.
- **performance 6.1** — no issue named; not counted (4 `EXISTS` subqueries run once per pick, not a hot path; indexes not checked).
