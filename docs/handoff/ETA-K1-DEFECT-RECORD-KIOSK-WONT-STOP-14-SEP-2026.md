# ETA — K1 DEFECT RECORD: a stopped kiosk keeps recording, and every operator view says it is idle
**14 September 2026 · Orchestrator · defect record, opened at V's instruction: "stop the kiosks and record the error — I know they were stopped, so there is a bug there."**

## 1. What is wrong, in one sentence

**Two OPD kiosks have been capturing audio and uploading it for days after their sessions were ended, and
every operator-facing view reports them as not recording.**

## 2. The evidence, all measured today

**The rooms.** `room_qyzghzaf` (OPD 7), session `bs_tt6xhqxt`, ended **13 Sep**.
`room_ux92qpws` (OPD 4 – Ortho), session `bs_3rmj9amg`, ended **11 Sep**.

**They are recording.** From the P4 provenance table (`ETA-P4-WINDOW-PROVENANCE-REPORT-14-SEP-2026.md`):
- Window grid starts run **06:45 → 12:30 IST today**. None are from 11 or 13 September.
- The gap between audio start and `closed_at` is **15.4–16.2 minutes** — a live close — with under
  0.15 min of spread inside each room, **48 windows without exception**.
- Each row is written **twice**: inserted open (`bench-window.ts:358`) about 5¼ minutes into its slot,
  then closed about 10 minutes later. A bulk admin pass inserts and closes in one go, with a ~0-minute
  gap. **The two timestamps on one row identify the writer** — this is how the process was named without
  reading any other table.
- Only two things in the repo write `closed_at`: `lib/bench-window.ts:379`, and migration 0068, a one-off
  applied long ago. **No reaper, no `resume-processing`, no backfill.** These rows came through
  `app/api/bench/chunks/route.ts:240 → bench-window.ts:379` — the live chunk-upload path.
- A `room_day` dated **14 Sep** was opened today for both rooms, and **only the chunk route creates one**
  (`ensureRoomDayOpen`, `chunks/route.ts:230`).
- **Still arriving at the moment of measurement:** each room's newest window (grid 12:45, still open) was
  created at **12:50:30** and **12:51:08 IST** — two to three minutes *after* a reading at 12:48 that
  reported "not recording".

**Every view says idle, and each is honest about a different thing.** This is why the defect survived:
- `scribe_diff_room` reports the room's **session** where status is recording. There is no such session,
  so it returns `recording: false`, `recording_session_id: null`, `last_piece_at: null`.
- `scribe_day_report` lists sessions **started** that day. None were, so it returns `sessions: []`.
- The windows count **chunks**, and chunks are still landing — inside session rows closed days ago.

All three are true. They disagree because they count different things. **The Orchestrator was misled by
exactly this and asserted twice that the rooms were idle; the Builder's measurement was right both times.**

## 3. The two defects, which are separate

**K1a — the kiosk does not stop.** V ended these sessions. The kiosks kept capturing and uploading. Either
the stop never reached the device, or the device treats "session ended" as a server-side fact that does not
halt its capture loop. The kiosk's stop path is where to look.

**K1b — the ingest accepts chunks for an ended session.** Whatever the kiosk does, the server should not
open a `room_day`, create a window and close it under a session whose row says `ended`. Either the ingest
does not check session state, or the end did not actually take. **This one is the containment**: fixing it
stops the data appearing even if the kiosk misbehaves.

**Do not fix one and call it done.** K1a explains the audio; K1b explains why nobody saw it.

## 4. What was done at 13:05 IST

`end_day` issued through the operator door to both rooms — the kind that **queues a `bench_command` for
the listening kiosk**, not `close_orphaned_session`, which is a server-side repair that involves no kiosk
at all. Both acked:

| Room | command | session returned | acked |
|---|---|---|---|
| OPD 7 | `cmd_nhqfwqj2` | `bs_tt6xhqxt` | 07:35:42 UTC |
| OPD 4 – Ortho | `cmd_tvrv8mq4` | `bs_3rmj9amg` | 07:35:54 UTC |

Both kiosks were listening at the time (`listener_state: listening`, listener age 1–3 s, `page_open: true`),
so the command had a live device to reach.

## 5. THE FALSIFIABLE TEST — this is the point of the record

Windows are created on a 15-minute grid, roughly **5 minutes into each slot**. The stop landed at 13:05.

> **If the stop worked, no window with a grid start of 13:15 or later will be created for either room.**
> **If a 13:15 window appears (expected around 13:20), the stop does not stop the kiosk — and K1a is
> reproduced on demand, with a command id to trace.**

Either outcome is useful and neither is ambiguous. **Check after 13:25 IST.** Whoever checks: query window
grid start and `created_at` for both rooms for anything at or after grid 13:15, and record the answer here.

### §5 RESULT — checked 13:50:43 IST by Builder `scribe` (read-only, one `BEGIN READ ONLY … ROLLBACK`)

**THE STOP WORKED. No window with a grid start at or after 13:15 IST exists for either room: `(0 rows)`.**
The check ran 35 minutes after the stop, so the 13:15, 13:30 and 13:45 slots were all due (≈13:20, 13:35,
13:50) and none was created. **K1a was NOT reproduced by this stop.**

| Room | windows grid ≥ 13:15 | most recent window, any state | grid start | created_at | closed_at |
|---|---|---|---|---|---|
| OPD 7 `room_qyzghzaf` | **0** | `bw_tt6xhqxt_1789371000000_primary`, `open`, `bs_tt6xhqxt` | 13:00:00 | 13:05:30 | — (never closed) |
| OPD 4 `room_ux92qpws` | **0** | `bw_3rmj9amg_1789371000000_primary`, `open`, `bs_3rmj9amg` | 13:00:00 | 13:06:09 | — (never closed) |

**What the timestamps add** (inference from window writes only; `bench_chunk` still not read):
- The last windows are the 13:00 slot, **left `open`**. The piece that would have completed the slot never
  arrived. So capture stopped partway through 13:00–13:15, which is what a stop at 13:05 predicts.
- OPD 7's last window was created at 13:05:30, **12 s before** `cmd_nhqfwqj2` was acknowledged (13:05:42).
  OPD 4's was created at 13:06:09, **15 s after** `cmd_tvrv8mq4` was acknowledged (13:05:54): consistent with
  one in-flight piece flushing on stop. Nothing followed either.

**Command ids.** `cmd_nhqfwqj2` (OPD 7) and `cmd_tvrv8mq4` (OPD 4) are recorded **as the stop that worked**,
not as a K1a reproduction.

**What this leaves open for K1a.** A queued `end_day` to a *listening* kiosk stops capture. The original
failure is unexplained: the sessions were stamped `ended` on 11/13 Sep with `ended_at = started_at`, and the
kiosks kept recording for days. The likeliest reading is that those ends never reached the device as a
command. One candidate is a server-side end (a reaper or `close_orphaned_session`, which involves no kiosk);
another is a stop sent while the kiosk was not listening. **Unverified.** §7 items 2 and 3 (`bench_chunk`
timestamps for 11–14 Sep, and the kiosk stop path) are still what would settle it. K1b is untouched by this
result: the ingest still accepted chunks for `ended` sessions through 13:06 today.

Query (read-only; tables `bench_window`, `bench_session`):
```sql
BEGIN READ ONLY; SET TIME ZONE 'Asia/Kolkata';
SELECT s.room_id, w.id, w.state, w.session_id, to_timestamp(w.start_ms/1000.0) AS grid_start, w.created_at, w.closed_at
  FROM bench_window w JOIN bench_session s ON s.id = w.session_id
 WHERE s.room_id IN ('room_qyzghzaf','room_ux92qpws')
   AND w.start_ms >= (extract(epoch FROM timestamptz '2026-09-14 13:15:00+05:30') * 1000)::bigint
 ORDER BY s.room_id, w.start_ms;                                    -- (0 rows)
SELECT DISTINCT ON (s.room_id) s.room_id, w.id, w.state, to_timestamp(w.start_ms/1000.0), w.created_at, w.closed_at
  FROM bench_window w JOIN bench_session s ON s.id = w.session_id
 WHERE s.room_id IN ('room_qyzghzaf','room_ux92qpws')
 ORDER BY s.room_id, w.start_ms DESC, w.created_at DESC;
ROLLBACK;
```
No room was commanded, no flag enabled, no drain run.

## 6. Blast radius, stated plainly

- **Storage** is already spent — days of empty-room audio in R2, at 15 minutes per window per room.
- **Transcription cost is zero so far, by luck.** Both rooms have **Transcript off**, which is the only
  reason `ROOM_AUTO_DRAIN_ENABLED` would skip them. Had Transcript been on and the flag set, we would have
  transcribed days of empty clinic rooms.
- **The drain is not implicated.** P4-2: the age gate behaves as an audio-recency filter on these rows, and
  the auto-drain would correctly skip both rooms. **The defect is at the kiosk and in the operator views.**
- **Clinical risk:** rooms believed to be off have been recording. On a working day that is patient audio
  captured outside a session anyone is watching. Today they were empty; that will not always be true.

## 7. Owed

1. The §5 check, after 13:25 IST.
2. `bench_chunk` upload timestamps for `bs_tt6xhqxt` and `bs_3rmj9amg` — direct evidence rather than
   inference from window writes. The Builder flagged it could not read that table under its kickoff's scope.
3. The kiosk's stop path — what a kiosk does on `end_day` when it believes it is already stopped.
4. **A liveness signal that counts chunks, not sessions.** Every existing view failed here. Until one
   exists, "is this room recording?" has no trustworthy answer, and that is the finding with the longest
   reach — it invalidated two Orchestrator rulings today alone.
5. The other five rooms have not been checked for the same pattern.
