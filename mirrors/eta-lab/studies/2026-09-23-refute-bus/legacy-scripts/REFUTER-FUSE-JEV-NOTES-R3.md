# REFUTER round 3 — 38a7dac (vinay/fuse-jev-reachable). VERDICT: PASS

## Scope / guard / migrations
`git diff --stat 5c0ceb3..38a7dac` = 2 files: lib/mcp/tools/fuse.ts (+70/-…), tests/unit/fuse-arms.test.ts.
`git diff --name-only 5c0ceb3..38a7dac -- db/` is EMPTY — no migration added, correctly.
merge-base(5c0ceb3, 38a7dac) = 5c0ceb3, so the branch is a clean single commit on top.
Branch pointers verified identical before and after all worktree work.

**The guard is untouched.** `if (day.scratch !== true)` does not appear in the diff at all. At
fuse.ts:229-231 it sits after `room_day_not_found` and before both `readCuesForFuse` and `runArm`,
so it fires for `jev` exactly as for rules/hybrid/flash. Mutant M4 (exempting jev from the guard)
turns the new non-scratch test red, so that test genuinely holds the line.

## runArm signature change — contained
`grep -rn "runArm("` over lib/ app/ services/ tests/ returns exactly two lines: the definition
(fuse.ts:171) and the single call site (fuse.ts:235). The rules / hybrid / flash branches never
read `day`; they are byte-identical. Nothing else calls it.

## The walk-back reaches the right sessions (coordinator item 5)
- `listBenchSessions` filters on `(s.started_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date`
  (lib/bench.ts:234).
- The scratch room-day is created by `resolveScratchRoomDay(scratchRoomId, istDate)`, whose own
  docstring (lib/brain/scratch.ts:161-164) says "The date is the session's own IST date, never the
  server clock", and `scratchRoomDayIdFor` builds the day id from that same string.
So both sides key on the session's IST date. They cannot diverge by construction; the replay's
creation date never enters. `SESSIONS_DEFAULT_LIMIT` is 200 (lib/bench.ts:195), ample per room-day.
`realRoomIdFor` is the exported inverse of `scratchRoomIdFor`, built from the same two constants,
and `resolveTapeSessionsForJev` checks `startsWith(SCRATCH_ROOM_PREFIX)` before calling it.

Multi-session days: the walk-back returns EVERY session the real room recorded that IST date, so a
two-session day now feeds both into the arm — newly reachable behaviour. I checked rather than
assumed: `runJevArm` partitions by `session_id` first (jev-arm.ts:127-142, comment "F3"), sorts
each session's windows by anchored epoch start, and orders sessions by their own epoch start with
a session_id tiebreak. The SQL's `ORDER BY start_ms` is therefore not load-bearing. Sound.

## Coordinator item 1 — is it a source-text guard or a behaviour test?
**Behaviour test.** Every assertion is on handler OUTPUT — `ok`, `error`, `detail`, `written`,
`already_existed`, and `visitRows.size` — plus one parameter-value check inside the responder
(`expect(values[0]).toEqual(["bs_jev1"])`), which inspects the bound parameter, not the text.
SQL text is used only to pick which mock rule answers. The decisive design choice is that the
builder kept the OLD `WHERE room_day_id = $1` shape answerable and returning `[]` on purpose,
which faithfully models the real fact that a scratch day's id never appears in jev_window_signal.
That is why M1 below goes red on output, not on a text assertion.

What the mock cannot establish, and I am not claiming it does:
- `start_ms`/`end_ms` are `bigint` (0106_jev_window_signal.sql:18-19), so the real Neon driver
  returns them as STRINGS; the mock supplies numbers. Harmless — `JevSignalRow` types them
  `string | number` and the mapper does `Number(row.start_ms)` (fuse.ts:138-139). The mock is
  unrepresentative, the code is not wrong.
- `session_id` is `text NOT NULL`; `= ANY($1)` with a JS string[] binds correctly on a pg-wire
  pool, and lib/brain/db.ts is `@neondatabase/serverless` **WebSocket Pool** (not the HTTP helper),
  so the binding is standard. But see F2.

## Coordinator item 2 — mutation (control: 62/62 green, reverted between cases)

| mutant | result |
|---|---|
| M1 — `readJevSignals` reverted to `WHERE room_day_id = $1` keyed on `day.id` | **2 RED** — REACHABILITY (`expected { ok: false } to match { ok: true, arm: 'jev' }`) and the re-run idempotency test (`expected { ok: false } to match { written: 1 }`). Exactly the two the builder named. |
| M2 — `resolveTapeSessionsForJev` returns `[]` | **3 RED** — the sessions-with-no-signals case, REACHABILITY, and idempotency |
| M3 — the two `detail` values inverted | **2 RED** — both fail-closed cases notice |
| M4 — scratch guard exempts arm `jev` | **1 RED** — the new non-scratch test |

M3 answers the coordinator's "see whether anything notices": it does.

## Test-count arithmetic (coordinator's closing ask)
- 140 unit test files at BOTH 5c0ceb3 and 38a7dac. `diff -rq wt3-pre/tests wt3-fix/tests` reports
  exactly ONE differing file: tests/unit/fuse-arms.test.ts. No test file added or removed.
- That file alone: **60 tests at 5c0ceb3, 62 at 38a7dac** — measured by running it at each commit,
  and matching a static `grep -c '  it('` of 60 and 62. So 3147 -> 3149 is exact.
- My clean run at 38a7dac: rc=0, 140 files passed, 3149 passed, 1 skipped, 94.83 s. The single
  skip is the same one present in rounds 1 and 2. Nothing silently skipped.

### Why I did not use a full baseline run for the +2
Two attempts at the 5c0ceb3 full suite collapsed: first 16 files failed / 86 failed / **47 skipped**,
then 17 files failed / 2 failed / **322 skipped** in 28 s. The Mini is at **2.1 GiB free (86% full)**
and `docker system prune` reclaimed 0 B, so the postgres-backed files could not bring containers up.
A collapsed run is recognisable by its skip count and its duration — which is exactly the
"silently not running" failure mode to watch for, and it is NOT present in the 38a7dac run
(1 skipped, 94.83 s, rc=0). The per-file 60->62 measurement is exact and does not depend on docker,
so it is better evidence than a flaky whole-suite baseline would have been.

## The job-kind enum claim — the builder is RIGHT, V's note needs correcting
- lib/jobs/kinds/index.ts:23 — `JOB_KINDS` includes `jevEnglishKind, jevWindowKind, jevRoleKind`.
- :25 — `export const JOB_KIND_NAMES = JOB_KINDS.map((k) => k.name);`
- lib/jobs/submit.ts:14 imports it from ./kinds and :77 re-exports it.
- lib/mcp/tools/jobs.ts:11 imports `JOB_KIND_NAMES` from @/lib/jobs/submit and uses it for the enum;
  the comment at jobs.ts:66 already records that "below was already JOB_KIND_NAMES; only the prose
  had drifted".
There is no defect. The three jev kinds are submittable through scribe_job_submit today.

## Findings (all NON-BLOCKING)
- **F1 — the new query is off the only index.** 0106_jev_window_signal.sql:34-35 creates
  `idx_jev_window_signal_room_day ON (room_day_id, start_ms)` and nothing on `session_id`. The fix
  moves the access path to `WHERE session_id = ANY($1)`, which now sequentially scans. No migration
  was added, which is right for this slice, but the cost is real and should be an index later.
  Bench-only table, small today.
- **F2 — the array binding has probably never run against the live database.** `= ANY($1)` at
  fuse.ts:133 is the ONLY array-parameter query in lib/ (ripgrep). The one that existed before —
  the deleted `readSessionsForJev` — sat behind `readJevSignals`, which returned nothing for every
  input, so it was unreachable. The suite mocks the brain pool, and the Scribe MCP door is down, so
  nothing in this review executed it for real. Standard pg-wire binding on a WS pool; low risk, but
  unproven.
- **F3 — the mock's row shape is not the driver's.** numbers where the column is `bigint`. Coerced
  correctly by the production mapper; noted so the next reader does not mistake the mock for a spec.
