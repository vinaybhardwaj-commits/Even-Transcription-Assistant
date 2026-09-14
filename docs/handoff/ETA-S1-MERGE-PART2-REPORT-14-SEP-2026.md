# ETA — S1 MERGE, PART 2 — REPORT
**14 September 2026 · Builder (`scribe`, restarted) · branch `vinay/s1-auto-drain` at `fe021a3` · not pushed this round**

This is written as its own file, `ETA-S1-MERGE-PART2-REPORT-14-SEP-2026.md`, not appended to the Part 1 report. Part 1 (`ETA-S1-MERGE-REPORT-14-SEP-2026.md`, still untracked) is left as its predecessor wrote it.

## Summary

| Step | Result |
|---|---|
| **C21** (migrations) | 0091 and 0092 applied to production. Both exit 0, both verified. |
| **C23** (eligible-window counts) | Counted read-only. **Column (2), eligible with Transcript on, is 0 for every room.** Column (1), ignoring Transcript, is **24 in two rooms**, both Transcript-off. That contradicts "nothing recording today" (F1). |
| **Not done** | Flag untouched, tunables untouched, no drain run, no promotion (V's), no push. |

**Pre-flight:**
- branch `vinay/s1-auto-drain`
- local `HEAD` = remote `refs/heads/vinay/s1-auto-drain` = `fe021a30f6ae70d4a6ffcf4efaf53332ef322527`
- no tracked changes
- `APP_DATABASE_URL`: **set** (checked by presence only)

**Handling of `APP_DATABASE_URL`:** used only as `"$APP_DATABASE_URL"`. Every `psql` output was piped through a filter masking any `postgres://…` string. Nothing was masked, because no output contained one. The value appears in no report, log or commit.

## 1. C21 — where we were pointed

**Identity line** (the kickoff's command, verbatim output):
```
neondb|neondb_owner|t
```
Neon's default database and owner role, with a non-null server address. That is consistent with the app's Neon HTTP driver.

**Corroborated before migrating**, with read-only queries limited to the tables §2 touches:
- `schema_migrations` from version 85 ends at `90 | 0090_diarize_run_id_and_service_guess`. The committed record `docs(handoff): 0089 and 0090 applied to production` says production has exactly that.
- `stt_engine` `gemini` row: `gemini | t | f | t` (id, enabled, fanout_enabled, is_paid) — enabled, as 0073 seeded it.
- `bench_window` columns `auto_drain_refused%`: `(0 rows)` — 0092 not yet applied.

This looked like production, so I proceeded.

## 2. C21 — migration 0091

**Command, as ordered:** `psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0091_disable_gemini_stt_engine.sql`
```
SET
UPDATE 1
INSERT 0 1
0091 psql exit: 0
```

**Verification — the `gemini` row:**
```
   id   | enabled | fanout_enabled | is_paid
--------+---------+----------------+---------
 gemini | f       | f              | t
(1 row)

 version |              name
---------+--------------------------------
      91 | 0091_disable_gemini_stt_engine
(1 row)
```
`enabled` went from `t` to **`f`**. `fanout_enabled` and `is_paid` are unchanged.

## 3. C21 — migration 0092

**Command, as ordered:** `psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0092_bench_window_auto_drain_refusal.sql`
```
SET
ALTER TABLE
ALTER TABLE
INSERT 0 1
0092 psql exit: 0
```
No lock timeout fired: the table's lock was free.

**Verification — the new columns on `bench_window`:**
```
        column_name        |        data_type         | is_nullable | column_default
---------------------------+--------------------------+-------------+----------------
 auto_drain_refused_at     | timestamp with time zone | YES         |
 auto_drain_refused_reason | text                     | YES         |
(2 rows)

 version |                 name
---------+--------------------------------------
      92 | 0092_bench_window_auto_drain_refusal
(1 row)
```
The DDL lines from `\d bench_window`:
```
          Column           |           Type           | Collation | Nullable |   Default
 auto_drain_refused_at     | timestamp with time zone |           |          |
 auto_drain_refused_reason | text                     |           |          |
```

## 4. C23 — eligible windows per room, read-only

**How it was run:**
- Inside `BEGIN READ ONLY; … ROLLBACK;`, at `db_now = 2026-09-14 06:51:58.88801+00`.
- Every room is listed (`room` LEFT JOIN `bench_session` LEFT JOIN `bench_window`), so a room with no windows shows 0 rather than disappearing.
- Both counts use the auto-drain selector's own predicates (`lib/stt/auto-drain.ts`) at the shipped defaults:
  - `state = 'closed'`, `grid_aligned`, `room_day_id IS NOT NULL`
  - `closed_at` within 6 h (`AUTO_DRAIN_MAX_AGE_HOURS`)
  - not refused within 60 min (`AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES`)
  - no queued or running `room_window` job
- (2) adds `room.transcript_enabled = TRUE`.
- Production's values for those two env vars were **not** read; the defaults are assumed.
- The cooldown clause cannot exclude anything yet, because 0092's columns are all NULL.

| room_id | transcript_enabled | (1) eligible, ignoring Transcript | (2) eligible, with Transcript |
|---|---|---|---|
| room_2qe955hy | **t** | 0 | 0 |
| room_4ggnkg5x | f | 0 | 0 |
| room_87frpus9 | f | 0 | 0 |
| room_bh6jtq4t | f | 0 | 0 |
| room_bn49z3zd | f | 0 | 0 |
| room_pnyc9u49 | f | 0 | 0 |
| room_qyzghzaf | f | **24** | 0 |
| room_scratch_bh6jtq4t | f | 0 | 0 |
| room_scratch_qyzghzaf | f | 0 | 0 |
| room_ux92qpws | f | **24** | 0 |
| room_xf5vcjpt | f | 0 | 0 |
| room_yh3etjpf | f | 0 | 0 |
| room_ymch4bxu | **t** | 0 | 0 |

**Reading it:**
- **(2) is 0 for every room.** Turned on now, the auto-drain would find nothing to drain.
- The two Transcript-on rooms (`room_2qe955hy`, `room_ymch4bxu`) have **no** recent eligible windows at all: 0 in (1) as well. Their zero means "no recent windows", not "Transcript off".
- `room_qyzghzaf` and `room_ux92qpws` each have **24** recent eligible windows and Transcript **off**. Their zero in (2) means "Transcript off", not "nothing there".

Per the kickoff, nothing was enabled. Enabling is V's call, on these numbers.

**Query (INFERRED against the migrations; ran read-only against production):**
```sql
BEGIN READ ONLY;
SELECT NOW() AS db_now;
SELECT r.id AS room_id,
       r.transcript_enabled,
       count(w.id) FILTER (WHERE w.state = 'closed'
                             AND w.grid_aligned = TRUE
                             AND w.room_day_id IS NOT NULL
                             AND w.closed_at >= NOW() - (6 * INTERVAL '1 hour')
                             AND (w.auto_drain_refused_at IS NULL OR w.auto_drain_refused_at < NOW() - (60 * INTERVAL '1 minute'))
                             AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
                          ) AS "1_eligible_ignoring_transcript",
       count(w.id) FILTER (WHERE w.state = 'closed'
                             AND w.grid_aligned = TRUE
                             AND w.room_day_id IS NOT NULL
                             AND w.closed_at >= NOW() - (6 * INTERVAL '1 hour')
                             AND (w.auto_drain_refused_at IS NULL OR w.auto_drain_refused_at < NOW() - (60 * INTERVAL '1 minute'))
                             AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
                             AND r.transcript_enabled = TRUE
                          ) AS "2_eligible_with_transcript"
  FROM room r
  LEFT JOIN bench_session s ON s.room_id = r.id
  LEFT JOIN bench_window w ON w.session_id = s.id
 GROUP BY r.id, r.transcript_enabled
 ORDER BY r.id;
ROLLBACK;
```

## 5. Flags

**F1 — the premise "nothing is recording today" is contradicted by the data.**
- Two rooms have exactly **24** windows closed in the last 6 hours. Windows are 15 minutes long (`WINDOW_MS`), so 24 is exactly 6 hours: both rooms look saturated, as if each has recorded continuously for the whole window.
- **Possible explanations I did not check:**
  - kiosks left recording through the holiday;
  - a pass closing older open windows late, which would set `closed_at` recently for audio recorded earlier;
  - scratch or bench sessions.
- The kickoff scopes this exception to the §3 counts, so I ran no diagnostic query (window start times, session state).
- **This matters beyond the flag:**
  - If those rooms are recording on a holiday, that is itself a fact the room-card and consent owners should see.
  - If the windows were closed late, then `closed_at` is not "when the audio was recorded", and the auto-drain's 6-hour recency bound means something different from what S1 assumed.
- One read-only query, `min/max(start_ms)` against `min/max(closed_at)` for those two rooms' eligible windows, would tell the two apart. It needs an explicit order.

**F2 — the identity check is corroboration, not proof.** `neondb|neondb_owner|t` is Neon's default naming, which any Neon database shares. What carried the decision was `schema_migrations` ending at 0090, matching the committed production record. Both are quoted in §1.

**F3 — env values assumed, not read.** The C23 counts use the code defaults (6 h, 60 min). If production sets `AUTO_DRAIN_MAX_AGE_HOURS` or `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES`, the live selector would use those instead. I named them and did not read them.

**F4 — queries beyond the kickoff's literal commands.** Two kinds, both inside §2's scope of "confirm you are pointed where you think you are / verify after each", and both on the migrated tables only:
- the pre-migration read of `schema_migrations`, the `gemini` row and the `bench_window` columns;
- `\d bench_window`, used to quote the DDL lines.

No other table was read except `room`, `bench_session` and `scribe_job`, inside the §3 count.

**Not mine, carried:** C22 promotion (V, by hand), then the health-sha check and G11 (watching `/api/jobs/run` fire in production).

## 6. Commit

This report and `ETA-S1-MERGE-PART2-CC-KICKOFF-14-SEP-2026.md` are committed by exact filename, with no code change, and **not pushed**, as ordered. Before the commit, the repo id guards ran over the staged set; their output is printed in the terminal. The commit's SHA is printed there too; this report cannot name the commit that contains it.
