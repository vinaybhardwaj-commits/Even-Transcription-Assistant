# ETA — level-log ops (retention route, scribe_room_levels). REFUTER VERDICT. 22 Sep 2026

`vinay/level-log-ops` **@ `6dd1b79`** (builder fleet), base `248c2ae`. Reviewed in my own detached worktree `/tmp/refute-lvl`. Production: read-only counts only. The live run used a **Neon test branch** under NEON-RULES:
- created `test/refuter-retention` = **`br-dry-hill-ao2wmzni`** from `main` (`br-still-fog-aondvfod`), endpoint `ep-floral-water-aowmvgmd`;
- **deleted** after the run; the project's branch list is now `main` only.

The connection string stayed in a 0600 file, was never printed or put in argv, and was removed.

## PASS

### Live retention run on the test branch
Seeded **252,000** rows dated 8–30 IST days ago, plus **500** rows on the cutoff day itself (today − 7). Today's **1,779** real rows were copied from main. I called the real route handlers (`POST`/`GET`) with `APP_DATABASE_URL` pointed at the branch:

| # | call | result |
|---|---|---|
| 1 | POST, flag unset | `forced_dry_run: true`, matched 252,000, deleted 0 |
| 2 | GET `x-vercel-cron`, flag unset | forced dry run, deleted 0 |
| 3 | GET, no auth | 401 `AUTH_REQUIRED` |
| 5 | POST `dryRun: true`, flag `on` | dry run, deleted 0 |
| 6 | POST, flag `on` | deleted **250,000**, 50 batches, `capped: true`, **5.2 s** |
| 7 | the same again | deleted **2,000**, 1 batch, 212 ms |
| 8 | the same again | deleted 0 (idempotent) |

Afterwards: older than cutoff **0**, cutoff day **500 kept**, newer **1,779 kept**. The boundary is correct: `ist_date < today − 7`, so today plus 7 earlier IST days are kept.

Call 4 (POST with a wrong bearer) threw "`cookies` called outside a request scope". That is my harness calling the handler outside Next, not the route. The route falls back to the admin cookie exactly as `/api/admin/reap-stuck` does.

### scribe_room_levels, live on the branch
- today: 1,779 samples in 252 buckets;
- cutoff day: 500 samples in 1 bucket;
- unknown room: 0;
- no room: `room_id_required`;
- scope is `read`, registered and appended to `PUBLISHED_TOOLS`.

The output has no text fields.

## Findings (all low; none blocks)
1. **The per-call cap sets a fleet size where a daily cron stops keeping up.** 50 × 5,000 = 250,000 rows per call. Today's rate for one room is about 1,100 rows per room-hour. A **daily** cron falls behind at roughly **9 rooms** if recorders post all 24 h, or **~23** if they post 12 h. When Fable schedules it, run it hourly, or size the cap to the fleet. `capped: true` tells the caller it is behind, but nothing else does (next item).
2. **Observability:** a successful run logs nothing; only failures `console.warn`. A cron's JSON body is not visible anywhere. Log the result object at info level.
3. **A bad `ist_date` falls back to today, silently.** "2026-13-45" returns today's buckets. The reply does echo `ist_date`, so a careful caller can tell. Returning `invalid_ist_date` would be safer.
4. **Mutations L7/L8 survive** (`<` → `<=` in the purge and in the count). The unit tests mock `sql`, so the SQL comparison is unpinned. My live run shows it is correct today. Add a SQL-shape assertion.
5. `count(*) … WHERE ist_date < X` has no index on `ist_date`; the only one leads with `room_id`. At about 8 days of fleet data, a sequential count is fine. Not worth an index yet.

## Gate
Targeted vitest: level-log-retention, mcp-room-levels, mcp-surface-aliases — **390 passed**. Mutations **11 of 13** killed. Killed: flag must be exactly `on`, dryRun honoured, GET and POST auth, short batch stops the loop, 7 days, cutoff arithmetic, batch cap, read scope, tool published, GET never dry-run-by-caller. Two survived: L7, L8.

## Jev — condensed diff, none of my findings in its context
Scores 5.4–7.4.
- **observability 5.4** (lowest) — **confirmed**: Finding 2.
- **reliability 5.9**, "timeout" — **partly confirmed** as Finding 1 (throughput per call). The timeout itself is **rejected**: 250,000 rows took 5.2 s against `maxDuration` 60.
- **security 6.4**, "auth boundary" — **not confirmed**. It copies the reap-stuck pattern, whose comment says Vercel strips client-supplied `x-vercel-*` (I did not verify this). Even a spoofed call can only delete rows the policy already deletes.
- **documentation 6.3** — **rejected**: the route header documents the flag, the auth and "not scheduled".
