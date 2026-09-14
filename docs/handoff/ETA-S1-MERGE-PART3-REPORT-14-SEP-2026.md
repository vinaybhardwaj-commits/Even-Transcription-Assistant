# ETA — S1 MERGE, PART 3 — REPORT (F1 tested: the bulk-close hypothesis is REFUTED)
**14 September 2026 · Builder (`scribe`, same session) · branch `vinay/s1-auto-drain` · local `HEAD` `83c985b`, remote still `fe021a3` · not pushed**

This is written as its own file, `ETA-S1-MERGE-PART3-REPORT-14-SEP-2026.md`; Parts 1 and 2 are unchanged. Everything here is read-only: one database read inside `BEGIN READ ONLY … ROLLBACK`, and code reads. No flag, tunable, drain, push, promotion, Mini work or test-suite run: `scribe3`'s M7 is live.

## Verdict

**Not a bulk close. The 24 `closed_at` values per room are spread evenly, one per 15-minute slot, each about 15½ minutes after its own window started.**
- The audio is **today's**: window starts run 01:00–06:45 UTC (06:30–12:15 IST).
- Each window was closed as the next chunk arrived after it ended, by the **live chunk-upload path**.
- **Both rooms are recording today**, into sessions whose rows say `ended` on 11 and 13 September.
- The premise "neither room has had a session today → cannot be real recording" does not hold. `last_session_at` and `status: ended` describe the session **row**, and this tape is still landing chunks into an old row.

The kickoff says to stop if the data confirms a bulk close. It refutes one, so I am stopping here with the evidence and adding nothing further.

## 1. C24 — per room

Query run at `db_now = 2026-09-14 07:03:27.254717+00`, over exactly the windows that satisfy the drain's age condition: the selector's predicates at code defaults, as in Part 2.

| | `room_qyzghzaf` (OPD 7) | `room_ux92qpws` (OPD 4 – Ortho) |
|---|---|---|
| windows | 24 | 24 |
| **min window start** (grid, `start_ms`) | 2026-09-14 01:00:00+00 | 2026-09-14 01:00:00+00 |
| **max window start** | 2026-09-14 06:45:00+00 | 2026-09-14 06:45:00+00 |
| **min `closed_at`** | 2026-09-14 01:15:25.959+00 | 2026-09-14 01:16:04.859+00 |
| **max `closed_at`** | 2026-09-14 07:00:31.886+00 | 2026-09-14 07:01:10.189+00 |
| `closed_at` range | 05:45:05.93 | 05:45:05.33 |
| distinct `closed_at` (to the second) | 24 (24) | 24 (24) |
| **lag, `closed_at` − window start** (min / max) | **00:15:25.45 / 00:15:31.89** | **00:16:03.27 / 00:16:10.19** |
| session | `bs_tt6xhqxt`, all 24 | `bs_3rmj9amg`, all 24 |
| session `status` | ended | ended |
| session `started_at` | 2026-09-13 03:46:40.135+00 | 2026-09-11 04:41:44.122+00 |
| **session `ended_at`** | **2026-09-13 03:46:40.134+00** | **2026-09-11 04:41:44.122+00** |

**Clustered or spread? SPREAD EVENLY — a live day.**
- 24 distinct `closed_at` values, down to the second, across 5h45m.
- 5h45m is exactly the start-to-start distance from the first slot to the 24th: 23 × 15 min.
- The lag after window start is nearly constant within each room: a spread of about 6 seconds in OPD 7, and about 7 seconds in OPD 4.

A bulk close would show many windows sharing one `closed_at` minute, with lags growing from hours to days. This shows every window closing 15m25s–16m10s after its own start, which is 25–70 s after it ended.

**The six-hour saturation is real but benign.** The rooms recorded continuously across the whole lookback, so the age window held its maximum of 24.

**Query (INFERRED against the migrations; ran read-only against production):**
```sql
BEGIN READ ONLY;
SELECT NOW() AS db_now;
WITH elig AS (
  SELECT s.room_id, w.session_id, w.start_ms, w.closed_at
    FROM bench_window w JOIN bench_session s ON s.id = w.session_id
   WHERE s.room_id IN ('room_qyzghzaf', 'room_ux92qpws')
     AND w.state = 'closed' AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
     AND w.closed_at >= NOW() - (6 * INTERVAL '1 hour')
     AND (w.auto_drain_refused_at IS NULL OR w.auto_drain_refused_at < NOW() - (60 * INTERVAL '1 minute'))
     AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
)
SELECT room_id, count(*) AS windows,
       to_timestamp(min(start_ms) / 1000.0) AS min_window_start, to_timestamp(max(start_ms) / 1000.0) AS max_window_start,
       min(closed_at) AS min_closed_at, max(closed_at) AS max_closed_at, max(closed_at) - min(closed_at) AS closed_at_range,
       count(DISTINCT closed_at) AS distinct_closed_at, count(DISTINCT date_trunc('second', closed_at)) AS distinct_closed_second,
       min(closed_at - to_timestamp(start_ms / 1000.0)) AS min_lag_after_window_start,
       max(closed_at - to_timestamp(start_ms / 1000.0)) AS max_lag_after_window_start
  FROM elig GROUP BY room_id ORDER BY room_id;
-- and, over the same elig set:
SELECT e.room_id, e.session_id, count(*) AS windows, bs.status, bs.started_at, bs.ended_at,
       min(e.closed_at) AS min_closed_at, max(e.closed_at) AS max_closed_at
  FROM elig e JOIN bench_session bs ON bs.id = e.session_id
 GROUP BY e.room_id, e.session_id, bs.status, bs.started_at, bs.ended_at ORDER BY e.room_id, e.session_id;
ROLLBACK;
```
Tables read: `bench_window`, `bench_session`, `scribe_job` (inside the selector's own clause). No other.

## 2. Which process closes a window

**Exactly one statement in the app writes `closed_at`:** `lib/bench-window.ts:379`, inside `evaluateAndWriteWindows` (`:318`):
```ts
UPDATE bench_window SET state = 'closed', closed_at = NOW()
 WHERE session_id = ${sessionId} AND start_ms = ${v.start_ms} AND end_ms = ${v.end_ms}
   AND source_mic = ${v.source_mic} AND state = 'open'
```
Search: `grep -rn "closed_at" lib app` and `grep -rn "SET state = 'closed'" lib app`. The only other `SET state = 'closed'` is `lib/stt/room-drain.ts:414`, which puts a failed drain back to `closed` and does not touch `closed_at`.

**Who calls `evaluateAndWriteWindows`** (the full list from `grep -rn evaluateAndWriteWindows lib app scripts`):
1. **`app/api/bench/chunks/route.ts:240`** — the chunk-upload route, in its post-response hook, on every verified chunk: `await evaluateAndWriteWindows(sessionId);`. **This is the closer for today's 48 windows.** It closes a slot as soon as verified chunks cover it end to end. That is why every lag is the slot's 15 minutes plus the upload latency of the covering chunk.
2. `app/api/admin/bench/windows/route.ts:107` — the admin POST, one `session_id` per signed-in call. A manual press closes whatever is complete in one pass, at one instant: the clustered signature this data does not show.

**The three candidates the kickoff named — checked, and none of them closes a window:**
- **hourly reap-stuck** (`app/api/admin/reap-stuck/route.ts`): no reference to `bench_window`, `closed_at` or the evaluator.
- **`resume-processing`** (`app/api/admin/resume-processing/route.ts`): none either.
- **day-rollover reaper** (`lib/bench-reaper-core.ts` Rule 2; the repair path in `lib/bench-orphan.ts:195`): these write `bench_session.status` / `ended_at`, never `bench_window`.

**So as the code stands, a window cannot be closed late in bulk by any scheduled process.** Only the chunk route (live) or a person pressing the admin POST (manual) can close one.

## 3. What the data does show — for the ruling

**R-a. On this evidence, the age gate IS an audio-recency filter, within about a minute.**
- `closed_at` trails the audio's end by the chunk-upload latency, because the only closers are the live chunk route and a manual press.
- The distinction §2 of the kickoff worried about holds only for the manual admin POST: a person re-evaluating an old session with chunks that were complete but never evaluated would stamp `closed_at = NOW()` on old audio.
- **Not observed today, and not ruled out in principle.** The chunk route also re-evaluates **the whole session** on every chunk, so a slot that becomes complete late (a delayed upload of an old chunk) would close late too. That is bounded by how late chunks can arrive.

**R-b. Two rooms are recording on a holiday, into sessions whose rows say `ended`.**
- OPD 7 and OPD 4 – Ortho have each landed a continuous tape since 06:30 IST today, still closing windows at the time of the read.
- Their sessions have `ended_at = started_at` to the millisecond (±1 ms of timestamp rounding). That is the shape `lib/bench-reaper-core.ts` Rule 1 writes for a session reaped with **zero chunks** ("ended_at = the honest last-audio time (newest chunk, else started_at)"), or a kiosk that ended its session before any piece landed.
- Chunks arriving for an `ended` session are a known, accepted case: the header of `app/api/bench/chunks/route.ts:22-37` is `bs_g3dwud4p`'s story, the chunk route keeps accepting pieces, and `chunkDisagreesWithEnd` flags it.
- **So `scribe_list_rooms` showing `last_session_at` on 11/13 Sep and `ended` does not mean "not recording".** The room card's evidence and the tape disagree, and the tape is the truth.
- Whether these rooms *should* be capturing ambient audio on a holiday is a consent and operations question for V. I have not looked at any audio or transcript.

**R-c. `room_2qe955hy` (Home Office), noted by the kickoff as the clean first room:** consistent with Part 2, it is Transcript on with 0 recent windows. Nothing new was read about it.

## 4. F3 caveat

The C23 counts (Part 2) and the C24 selection here assume the code defaults: `AUTO_DRAIN_MAX_AGE_HOURS` = 6, `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` = 60. Production's values were **not** read; this session has no Vercel access. V checks both in the Vercel dashboard at promotion. **If either is set to a non-default value, re-run both counts.** For C24, the room list and the clustering verdict would not change, but the window counts would.

## 5. Flags

- **P3-1:** the kickoff's premise is refuted by its own test. Real recording, not a late close (Verdict, §1).
- **P3-2:** the room list's `last_session_at` / `status` understate live capture whenever a tape outlives its session row (R-b). Anything that reads "is this room recording?" from the session row, whether the room card, an operator, or a future flag decision, will be wrong in exactly this state.
- **P3-3:** the only late-close path is the manual admin POST, plus late-arriving chunks (R-a). Still worth a ruling on whether the age gate should key on `start_ms` rather than `closed_at`. Not changed; the decision is the Orchestrator's.
- **P3-4:** no id-shaped token appears here; checked with `grep`, since the guard suite was not run because M7 is live. Session and room ids are quoted; no session label, room-day content, audio or transcript was read.

## 6. Commit

This report and `ETA-S1-MERGE-PART3-CC-KICKOFF-14-SEP-2026.md` are committed by exact filename, with no code change, and **not pushed**. The SHA is printed in the terminal.
