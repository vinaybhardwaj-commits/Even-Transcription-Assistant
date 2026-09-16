# ETA-F5 — The diarize crash window: root cause, detectability, blast radius, options · 15 Sep 2026 · Debugger (Builder pane)

Read-only. Nothing built, committed, pushed or migrated. The code was read in `git archive` copies under the session
scratchpad: 8c4a18c (E24) and 836188f (s1 branch head). One read outside the copies: the installed
`@neondatabase/serverless` type definitions, read by path under the -e16 worktree's `node_modules`. No work was done
there. Job evidence comes from the Scribe MCP (`scribe_job_list`, `scribe_job_status`), counts, ids and timestamps only.
Process inspection: none.

## 0. The write order is the same on every branch

`lib/jobs/kinds/diarize-window.ts` and `lib/stt/diarize-window.ts` have the same shape at 836188f (pre-E24) and 8c4a18c
(E24). F5 is not introduced by E24; E24 adds a third statement after the second.

**Which commit production runs is UNVERIFIED.** `git ls-remote origin refs/heads/main` answers `7ffb168` (25 Aug), which
has no diarize job at all, yet the job queue shows `diarize_window` jobs on 14 Sep. So production does not deploy from
that ref, or that ref is not the deploy source.

## 1. The window of vulnerability, statement by statement

One `diarize_window` job step (`lib/jobs/kinds/diarize-window.ts` `run`) runs, in order:

| # | Statement | File:line (8c4a18c) | Durable effect |
|---|---|---|---|
| 1 | `runDiarize` — queue wait for the depth-1 slot (up to `DIARIZE_QUEUE_WAIT_MS` 120 s, "not clocked"), then the service call (up to `DIARIZE_TIMEOUT_MS` 300 s) | `lib/stt/diarize-window.ts:146`, `lib/diarize.ts:139-167`, `lib/diarize-gate.ts:56` | None |
| 2 | `loadWindowTurns` — one SELECT | `lib/stt/diarize-window.ts:160` | None |
| 3 | **The turn loop: one `INSERT … ON CONFLICT (window_id, source_ref) DO UPDATE SET run_id = EXCLUDED.run_id, …` per binding** | `lib/stt/diarize-window.ts:168-192` | **Each row moves to the new run id as it commits** |
| 4 | `recordDiarizeWindow` — one upsert; moves `last_run_id` (and, under E24, `segments_run_id` only on a failed row) | `lib/jobs/kinds/diarize-window.ts:76` | The window learns the run |
| 5 | (E24 only) `repairStaleDiarizeSegments` — one UPDATE | `lib/jobs/kinds/diarize-window.ts:87` | Repair |
| 6 | Runner: `finishJob` (lease-guarded) | `lib/jobs/runner.ts:111` | Job done |

**The F5 window is statements 3 and 4:** from the first turn INSERT committing to the upsert committing. Its size is
measured on a real job: `job_tqbktnynwiix` bound 317 turns, the service took 44.3 s of a 67.8 s step, so statements 2
to 6 took about 23 s. That is **roughly a third of the job's wall time, about 70 ms per turn**. Treat that per-row
figure as INFERRED: it is the remainder after the service latency, not a direct measurement of the loop.

**Realistic failure surfaces:**
- **A Neon HTTP error on one of the ~317 INSERTs** (a connection drop, a 5xx, a timeout). The loop throws and
  `runOneStep` records `step_threw` (`runner.ts:79-96`). The rows already committed stay on the new run id.
- **A Vercel kill at `maxDuration = 300`** (`app/api/jobs/run/route.ts:24`). The step's own budget does not bound it:
  a 120 s queue wait plus a 300 s service timeout is 420 s, beyond both `MAX_STEP_MS` 200 s and `LEASE_MS` 240 s. So
  the kill can land anywhere, and it lands inside statements 3 and 4 when the service answers between about 277 s and
  300 s. UNVERIFIED how often the service gets that slow; the longest observed job step is about 100 s.
- **A zombie writer.** A step past `LEASE_MS` 240 s loses its lease, and another runner may reclaim the job (the claim
  takes `running` rows with an expired lease, `store.ts:90-91`). The first runner's statements 3, 4 and 5 are not
  lease-guarded: only the runner's own `finishJob`, `failJob` and `saveStep` check `lease_owner`. So a lease-lost
  runner keeps writing turn rows and can still record `last_run_id`.

**When the state persists, and when it heals.**
- A thrown or killed step is retried from statement 1 with a new `randomUUID()` (`kinds/diarize-window.ts:49`). The
  retry re-diarizes and rewrites every turn it binds under that id before recording, so **a successful retry heals
  F5**.
- On a window diarized for the first time, emotion cannot run until some run records `ok`, and that run wrote all its
  bindings first. **A first-run crash is therefore never scored in the broken state.**
- **F5 persists only when all of these hold:**
  - (a) the window already has an `ok` diarize row from an earlier run r1, so this is an operator re-run: the diarize
    scan never re-offers an `ok` row (`diarize-job.ts:131`);
  - (b) the re-run r2 is interrupted inside statements 3 and 4;
  - (c) no later run succeeds: retries exhausted (`MAX_FAILURES` 3), a non-retryable service failure (recorded
    `failed` over `ok`, which the keep-rule ignores, and `last_run_id` stays r1 by `COALESCE`), or the job lost its
    lease with no reclaim;
  - (d) emotion then runs against r1: the window was unscored, or `failed` with attempts left. A window already scored
    under r1 is not re-offered, and its span rows predate the damage.
- **What emotion then does:** it reads `t.run_id = last_run_id = r1` (`emotion-window.ts:136-142`). Turns r2 rebound
  now carry r2 and are **silently excluded**. The window scores the turns r2 had not reached. Under E24,
  `segments_run_id = r1 = last_run_id`, so `diarize_stale` does not fire.
- **A second consumer shows the mixed state too:** the MCP tool at `lib/mcp/tools/stt.ts:406-414` lists
  `room_turn_speaker` with no `run_id` filter. It shows r2's speaker numbers beside r1's, with no field saying which
  run each row came from.

## 2. Is anything atomic? No

- `lib/db.ts` builds `neon(url)`, the Neon **HTTP** driver. Every `sql\`…\`` call is one HTTP request, and each
  statement autocommits.
- The job step makes 1 SELECT, N INSERTs (317 in the measured job), 1 upsert and, under E24, 1 UPDATE: **N + 2 or
  N + 3 separate commits**. Each statement is atomic by itself; nothing groups them.
- `sql.transaction()` exists in the installed `@neondatabase/serverless` 0.10.4 (its `index.d.ts` documents
  transaction isolation and `readOnly`). No server code uses it: `git grep '.transaction('` in lib and app finds only
  IndexedDB calls in `lib/use-room-recorder.ts`. Whether its non-interactive batch mode fits this sequence is
  UNVERIFIED at runtime.

## 3. Detectability after the fact — derivable, but not directly visible

**Not directly.** Nothing records that a run started:
- `room_turn_speaker` has `created_at` only, and `ON CONFLICT DO UPDATE` does not touch it, so rewritten rows keep
  their first insert time;
- there is no per-row `updated_at`;
- no table lists the run ids a window has had: `room_diarize_window` holds only `last_run_id`, plus `segments_run_id`
  under E24;
- the job row does not carry the run id: it lives only in the step's memory (`kinds/diarize-window.ts:49`), and the
  result has counts only.

**The naive query overcounts by design.** "Turn rows whose `run_id` ≠ the window's `last_run_id`" matches F5, but it
also matches every normal re-run. A turn the newer run did not bind (no overlap with its segments) keeps the older
run's id, and 0090 and the emotion job's own comment say so ("a turn row the latest run did not rewrite belongs to an
earlier run"). Windows whose turn rows predate 0090 add NULL run ids.

**What does separate them — derivable, INFERRED, not run.** A legitimate older row is a turn the latest run did not
bind: its turn overlaps none of the latest run's intervals. An F5 orphan is a turn the latest run did bind, then
overwritten by a run that never recorded: its turn overlaps the latest run's intervals, yet its `run_id` is not
`last_run_id`. `bindTurnsExclusive` binds any turn with any overlap > 0 (`speaker-roles.ts:152-161`), so "overlaps the
last run's segments" is exactly "the last run wrote this row".

**This is exact only when `segments_json` belongs to `last_run_id`:**
- Under E24: `segments_run_id = last_run_id`.
- Pre-E24: true for a window never successfully re-run. It is also true in the F5 case itself, because r2 never
  recorded, so both columns are still r1's.
- A window successfully re-run pre-E24 keeps r1's segments with r2's `last_run_id`. That is the E16 stale class, and it
  gives false positives here.

```sql
-- F5 orphan detector — READ-ONLY, INFERRED (not executed: no database access in this pane).
-- Add `AND d.segments_run_id = d.last_run_id` once 0099 exists; without it, pre-E24 re-run windows can false-positive.
WITH w AS (
  SELECT d.window_id, d.last_run_id, d.segments_json, bw.start_ms::bigint AS w0
    FROM room_diarize_window d
    JOIN bench_window bw ON bw.id = d.window_id
   WHERE d.state = 'ok' AND d.last_run_id IS NOT NULL AND jsonb_typeof(d.segments_json) = 'array'
),
seg AS (
  SELECT w.window_id, w.w0 + (s->>'start_ms')::numeric AS s0, w.w0 + (s->>'end_ms')::numeric AS s1
    FROM w, jsonb_array_elements(w.segments_json) AS s
),
foreign_rows AS (
  SELECT t.window_id, t.run_id, (c.payload->>'start_ms')::bigint AS t0, (c.payload->>'end_ms')::bigint AS t1
    FROM room_turn_speaker t
    JOIN w ON w.window_id = t.window_id
    JOIN cue c ON c.source_ref = t.source_ref AND c.type = 'stt_turn' AND c.room_day_id = t.room_day_id
   WHERE t.run_id IS DISTINCT FROM w.last_run_id
)
SELECT f.window_id, count(*) AS orphan_turns, count(DISTINCT f.run_id) AS unrecorded_runs
  FROM foreign_rows f
 WHERE EXISTS (SELECT 1 FROM seg WHERE seg.window_id = f.window_id AND LEAST(seg.s1, f.t1) - GREATEST(seg.s0, f.t0) > 0)
 GROUP BY f.window_id
 ORDER BY orphan_turns DESC;
```

**Corroboration from the job queue.** Every F5 interruption leaves a trace on `scribe_job`:
- `failures >= 1` (a throw),
- `attempts >= 2` (a reclaim),
- `error_code` in (`step_threw`, `failures_exceeded`, `lease_lost`), or
- a `running` row whose lease has expired.

It cannot name the window's broken turns; it can say where to look.

**Answer.** F5 is not directly visible. It is derivable by one query, exactly under E24 and with known false positives
before it. Detection can therefore stand in for prevention, but only if someone runs the query: nothing runs it today.

## 4. Blast radius — the database count could NOT be established

- **Not run:** the naive count and the orphan query in §3. This pane has no database connection (repo CLAUDE.md: "No
  live database in this sandbox"), and the Scribe MCP exposes no SQL tool. Both queries are above, ready for the
  Orchestrator.
- **What the job queue shows** (`scribe_job_list kind=diarize_window`, all 12 rows returned under `limit 200`):
  - 9 `done`, every one with `attempts 1, failures 0`. Cron jobs between 11:25 and 13:36 UTC on 14 Sep; two operator
    (`mcp:operator-v1`) jobs at 04:01 and 04:06 UTC.
  - 3 `failed` with `progress_incomplete: no such window`, which fails before any turn write.
  - None `running`, none `lease_lost`, none `failures_exceeded`, none `step_threw`.
  - **So there are zero interrupted diarize steps in the visible history, and zero F5 candidates by job evidence.**
- **Caveats:**
  - (1) Job-table retention is UNVERIFIED; 12 rows from 14 Sep may not be the full history since C2 (12 Sep).
  - (2) Windows diarized by the inline pass before the job kind (`aedd3ed`, 12 Sep) leave no job row.
  - (3) One of my two `scribe_job_status` calls (`job_n58z0iqkscvh`) was refused by the permission classifier, so that
    operator job's window id and counts are not in this report. I did not retry it.
- **Structural bound:** F5 needs an operator re-run of an `ok` window (§1 (a)). Two such operator jobs appear in the
  history, and both finished in one attempt with no failure.

## 5. Options, ranked by how much silent wrongness each removes per unit of change (not a recommendation)

| Rank | Option | Removes | Cost and trade-offs |
|---|---|---|---|
| 1 | **Make 3–4 one atomic write.** Either one statement (`WITH ins AS (INSERT INTO room_turn_speaker … SELECT FROM jsonb_to_recordset($bindings) … ON CONFLICT …) INSERT INTO room_diarize_window … ON CONFLICT …`), or Neon's `sql.transaction([...])` batch. | The whole crash window, and the zombie's partial rows (a batch either commits or does not). Also cuts ~317 round trips to 1, which shortens the step. | The writer is rewritten, and the keep-rule CASE and E24 repair move inside the statement. The batch form is UNVERIFIED on 0.10.4 at runtime. A lease-lost zombie can still commit a whole run late (see rank 5). |
| 2 | **Stamp every turn row with its run, append-only, and flip a pointer.** Key rows `(window_id, source_ref, run_id)`; `recordDiarizeWindow` moving `last_run_id` is the atomic flip; readers select `run_id = last_run_id`. | F5 entirely without transactions: an unrecorded run's rows are never read. Keeps history, which also makes §3 exact. | Changes the 0074 PK (migration), needs cleanup of old runs, and the `stt.ts` reader must learn the filter. Rows the latest run did not bind vanish from the current view: a semantic change from today's "older binding kept". |
| 3 | **Detect instead of prevent.** Run the §3 query (in emotion `prepare` before scoring, recording a named state, e.g. `diarize_turns_partial`, as E24 did for stale segments; or as a health, cron or MCP check). | The silence: the wrong answer becomes a named one. Catches every cause (throw, kill, zombie). | Exact only with `segments_run_id = last_run_id` (E24); one extra query per window; heals nothing, so the window still needs a re-diarize, and under E24's F1 finding the operator door has its own two-run cost. |
| 4 | **Intent marker.** Write `pending_run_id` on `room_diarize_window` before statement 3 and clear it in statement 4. | Makes detection exact and cheap (`pending_run_id IS NOT NULL` with a dead job); no inference. | Migration; still two writes around N writes (not atomic); a pre-marker write can itself fail; keep-rule interplay must be specified. |
| 5 | **Lease-guard the step's writes.** Condition statements 3–5 on `scribe_job.lease_owner = runner`. | The zombie surface only. | Does not stop a Neon throw or a kill mid-loop; adds a join to every write. |
| 6 | **Make the diarize step honour its budget.** Clock the queue wait against `MAX_STEP_MS`; cap the service timeout below `LEASE_MS` minus the loop. | Lowers the chance of a kill or lease loss inside 3–4. | Frequency only, not the sequence; a slow service now fails earlier, which is loud and retryable. |
| 7 | **Do nothing.** | — | The persistence conditions (§1 (a)–(d)) are narrow, and job history shows zero interrupted diarize steps. The cost if it happens is exactly the brief's concern: a plausible, silent, partial score, undetectable unless option 3's query is run by hand. |

Options 1 or 2 combine naturally with 3 (prevent, and check the backlog once). Options 5 and 6 are hardening that
helps any of them.

## 6. Not established, and why

- **The live count of affected windows:** no database access in this pane; SQL provided in §3.
- **The commit production runs:** the remote `main` ref (`7ffb168`, 25 Aug) predates the diarize job, which contradicts
  the 14 Sep jobs; the deploy source is UNVERIFIED.
- **Job-table retention, and windows from the pre-job inline pass:** not visible through the MCP.
- **The window id and counts of `job_n58z0iqkscvh`:** that status call was denied by the permission classifier.
- **The per-row INSERT latency:** INFERRED from one job (step wall time minus service latency ÷ 317), not measured directly.
