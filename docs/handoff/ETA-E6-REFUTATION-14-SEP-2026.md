# ETA-E6 — refutation of the E4 ruling's evidence · 14 Sep 2026 · Builder (Refuter brief) · PARTIAL
**The live Neon read was denied by this session's permission layer** ("Production Reads"). I did not work around it. Every verdict below that needs live data is UNVERIFIED. The queries are written and ready: `docs/handoff/scratch/E6-QUERIES-14-SEP-2026.sql`, read-only, cut at 14 Sep 00:00 IST, not run. Source verdicts are at `fe021a3`.

## 1. Verdicts
- **C1 — UNVERIFIED.** No live data read. Source says a day is not the unit phase is fixed over (V5), so the 09/10 vs 11/12 Sep split cannot be judged without the per-run cut.
- **C2 — UPHELD (source).** The grid is one shared IST quarter-hour for every room, session and kiosk.
- **C3 — UNVERIFIED.** Source names three ways the count inflates (§3). Not measured.
- **C4 — count UNVERIFIED (not attacked). Explanation BROKEN (source).** The missing flags were enough to produce zero rows, but they were not the only reason. The unattended pipeline has no head while `ROOM_AUTO_DRAIN_ENABLED` is off (§4).
- **V5 — UNVERIFIED on data. Source says the honest unit is the kiosk run, not the day.** Phase resets on pause/resume, on a page reload or rejoin, and on start of day (§5). A per-day sd over a day with resets mixes several phases, the same aggregation error as rule 16 one level down.
- **V6 — UNVERIFIED.** Source splits close lag exactly into rotation phase (0–300 s) plus upload/verify latency. Which one dominates is a data question. One bound is certain: any lag over 300 s is latency (§6).

## 2. C2 — UPHELD, from source
- `slotStartFor` (`lib/bench-window.ts:122-124`) is `floor((atMs + IST_OFFSET_MS) / WINDOW_MS) * WINDOW_MS − IST_OFFSET_MS`, with `WINDOW_MS` = 900 000 and the offset 5.5 h (`:84-85`). It is epoch-absolute. No room, session, kiosk or start time enters it. Every slot in every room starts at IST :00/:15/:30/:45.
- `grid_aligned` anchors nothing. The only writer inserts it as a literal `TRUE` (`:358`), and 0057 defaults it `TRUE` (`0057:62`). No code path writes `FALSE`. It is a constant, not a per-room property.
- So two rooms' windows for the same slot carry the same `end_ms`. `closed_at = NOW()` (`:379`) is written when that session's covering chunk is verified (`app/api/bench/chunks/route.ts:240`, in the `after()` hook). The larger close lag therefore gives the later `closed_at` and wins `ORDER BY w.closed_at DESC` (`lib/stt/auto-drain.ts:126`). The ranking the ruling assumed is real.
- The live check is written but not run (C2-live in the SQL): windows with `end_ms % 900000 <> 0`.

## 3. C3 — UNVERIFIED; three inflation sources in source the count must exclude
1. **Counting by close hour, not recording hour.** R6's own lags reach 64,517 s. A window verified 18 h late adds its room to an hour in which that room recorded nothing. `COUNT(DISTINCT room_id)` over windows *closed* in an hour counts it. The SQL counts both ways, by `start_ms` hour and by `closed_at` hour, for comparison.
2. **Two rows for one slot in one session.** The window key is `(session_id, start_ms, end_ms, source_mic)` (`bench-window.ts:360`). The lane is decided per session on every re-evaluation (`decideBinding`, `:256-263`). If that decision flips mid-day, every slot touched after the flip gets a second row on the other lane. That inflates windows per hour, not rooms.
3. **Two sessions for one room.** Rejoins, re-opened sessions and the 0068 rebind (`rebound_from`) put more than one session under a room. That inflates windows, not rooms, unless session→room binding differs.
Only (1) inflates the room count. (2) and (3) inflate the 28–32 windows an hour. The SQL counts duplicate room-slots directly.

## 4. C4 — the explanation is BROKEN: a second reason, from source
The ruling says the pipeline was dormant because `ROOM_DIARIZE_ENABLED` and `EMOTION_ENABLED` did not exist in Vercel. They were sufficient. They are not the only gate, and turning them on does not make the unattended path run:
- **Diarize needs a clip.** `enqueueDiarizeWindows` selects only `w.clip_r2_key IS NOT NULL` (`lib/stt/diarize-job.ts:131`). Emotion needs a diarize row that is `ok` with a `last_run_id` (`lib/emotion/enqueue.ts:58-60`).
- **`clip_r2_key` has exactly one writer:** `roomWindowPrepare`, the join (`lib/stt/room-drain.ts:643`), reached only through `drainRoomWindow`. Its callers at `fe021a3` are `lib/stt/auto-drain.ts:135` (the `*/5` cron, **flag off since it shipped, kept off by R1**), `app/api/admin/bench/drain/route.ts:97,102` (admin cookie), and `app/api/admin/bench/run-waiting/route.ts:63` (admin).
- **No other cron writes it.** The seven crons are reap-stuck, resume-processing, measure-windows, diarize-windows, emotion-windows, drain-windows and jobs/run. `resume-processing` touches `encounter` only, `reap-stuck` reaps sessions, and `measure-windows` writes `stt_window_measure`/`stt_window_score`.
- **Consequence.** With both flags on and R1 in force, diarize has no eligible window unless a person drains one. Emotion has none unless diarize ran. **The unattended pipeline still produces zero rows today, by construction.** The live ~15 `room_diarize_window` rows (manual probes) fit this.
- **A third gate, unmeasured.** `room.transcript_enabled` defaults to `FALSE` (`0065:30`). Auto-drain's join requires it `TRUE` (`auto-drain.ts:113`), and so does the close-time legacy enqueue (`bench-window.ts:397`). If no room has Transcript on, lifting R1 would still drain nothing. The count query is in the SQL.
- **What this invalidates.** §1.3's sentence "dormant by absence" is incomplete. R4's framing that "the flags went live today" implies a live pipeline is wrong for the unattended path. **E5 itself is not blind:** its kickoff step 2 requires the entry point that `auto-drain.ts` enqueues through, i.e. a manual drain. R1 stands: its reasons are capacity and service rate, not this. But R1 also means the two flags flipped today have no unattended effect until the drain is on.

## 5. V5 — the kiosk run is the unit (source); data UNVERIFIED
- **Browser kiosk.** `scheduleRotate` re-arms a 5-min `setTimeout` (`lib/use-room-recorder.ts:1217-1266`), and each run carries a new phase. It is called from `startDay` (`:1308-1309`), from a reload/rejoin resume (`:1442-1443`), and from `resumeDay` after every pause (`:1529`). `pauseDay` clears it (`:1488`). Each resume starts a fresh phase set by the moment of the resume.
- **Native Room Recorder.** Pieces are 4,800,000 samples = 300 s at 16 kHz (`apps/room-recorder/Sources/RoomRecorderCore/PiecePipeline.swift:231`), so phase is fixed per capture run and resets when capture restarts.
- **Consequence.** A clinic that pauses between patients (the IRB pause, `pauseDay` at `:1486`) has as many phases in a day as it has pauses. A tight per-day sd (09/10 Sep) means few resets that day. A loose one (11/12 Sep) is what several runs averaged together look like, not per-window jitter. **If so, the loose days are not "milder starvation": inside each run the phase is still rigid, and the rank order simply reshuffles at each reset.** That turns C1's question around. Which room starves changes through the day, but starvation within each run survives. This is inference until the per-run query runs: runs are split where `gap_before_ms > 0`, compared with the per-day sd.

## 6. V6 — phase or latency: the split is exact, the answer needs data
By construction, close lag = (covering chunk `ended_at` − `end_ms`) + (`closed_at` − chunk `ended_at`).
- **The first term** is rotation phase, bounded to [0, 300) s.
- **The second** is upload plus verify latency, and it is unbounded: an offline queue drains hours later.
- **Bound.** R6's 64,517 s lags are latency by definition. Medians spread 45–298 s inside 300 s look like phase, but that is not proof.
- **The fix differs.** If phase dominates, rank on something the recorder sets per run. If latency dominates, rank on a recorder-side timestamp such as chunk `ended_at` rather than `closed_at`, which is R6's own requirement. The SQL's V6 query gives the variance share per room-day.

## 7. The model at 7, 8 and 9 rooms (C3's counts), post-fix selector
`docs/handoff/scratch/E6-MODEL-ROOMCOUNT-14-SEP-2026.py.txt` loads the E4 model verbatim. 300 phase sets per row.

| Rooms (windows) | drained · aged out | rooms with 0 in clinic, ±0 s / ±30 s / ±150 s | worst room |
|---|---|---|---|
| 6 (216) | 144 · 72 | 3 / median 2 / 0 | 12/36 |
| 7 (252) | 148 · 104 | 4 / median 2 / 0 | 10/36 |
| 8 (288) | 153 · 135 (47%) | 5 / median 3 / 0–1 | 9/36 |
| 9 (324) | 156 · 168 (52%) | 6 / median 4 / 0–1 | 8/36 |

Totals barely move with room count, because capacity is fixed at 12 an hour. What grows is the number of rooms that get nothing in clinic: always 3 fed at ±0 s, so R − 3 starve. §1.2's "understated" holds in the model, if C3's count holds.

## 8. What should have been checked
1. §4: the flags were never the only gate. The pipeline head is the drain, and `clip_r2_key` has one writer.
2. `room.transcript_enabled` per room. Default `FALSE`, and it gates both the drain and the legacy enqueue.
3. The unit of phase stability (§5), before choosing a per-day cut.
4. C3 by recording hour, not close hour. R6's own lags show why.
5. My E4 model cited only the browser kiosk's timer. The native app cuts by sample count. Both give a fixed phase per run, but which client each room runs is not in source and should be read from live data before V6 is ruled.

Files: this report; `scratch/E6-QUERIES-14-SEP-2026.sql` (not run); `scratch/E6-MODEL-ROOMCOUNT-14-SEP-2026.py.txt` and `-OUT-…txt`. No code, flag, env, migration or job touched. No 14 Sep data read. Subagents: none.
