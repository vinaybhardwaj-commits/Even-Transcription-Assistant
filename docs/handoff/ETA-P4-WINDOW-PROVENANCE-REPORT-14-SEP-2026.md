# ETA — P4 — WINDOW PROVENANCE — REPORT
**14 Sep 2026 · Builder `scribe` · read-only · not pushed**

**Full per-window table** (48 rows, all times IST): `docs/handoff/scratch/P4-WINDOW-PROVENANCE-TABLE-14-SEP-2026.txt` — untracked, cited only. It was one `BEGIN READ ONLY … ROLLBACK` at `db_now 2026-09-14 12:55:00 IST`, using the same age-condition set as P2/P3; that set slides with `NOW()`. No transcript text or audio was read. No room was commanded.

## Summary per room (IST)
| | OPD 7 `room_qyzghzaf` | OPD 4 `room_ux92qpws` |
|---|---|---|
| windows in set | 24 | 24 |
| grid start, first .. last | 14 Sep 06:45 .. 12:30 | 14 Sep 06:45 .. 12:30 |
| `closed_at`, first .. last (distinct) | 07:00:26 .. 12:45:31 (24) | 07:01:04 .. 12:46:07 (24) |
| **gap** `closed_at` − grid start | **15.42 – 15.53 min** | **16.05 – 16.17 min** |
| row `created_at` − grid start | ≈ 5.4 min | ≈ 6.1 min |
| **`created_at` → `closed_at`** | **9.95 – 10.03 min** | **9.92 – 10.05 min** |
| sessions | 1: `bs_tt6xhqxt` | 1: `bs_3rmj9amg` |
| session started → ended | **13 Sep 09:16:40 → 13 Sep 09:16:40** | **11 Sep 10:11:44 → 11 Sep 10:11:44** |
| room_day | `rd_zee5hsef`, date 2026-09-14 | one room_day, date 2026-09-14 |
| **most recent window, any state** | grid **12:45**, `open`, created **12:50:30**, not closed | grid **12:45**, `open`, created **12:51:08**, not closed |

## The four answers, per room (identical for both)
1. **Grid starts are TODAY**, 14 Sep 06:45 → 12:30 IST. None fall on 11 or 13 Sep.
2. **The gap is about 15–16 minutes: a live close.** Nothing is hours or days late, and the spread is under 0.15 min per room.
3. **Yes.** Every window belongs to one session whose row was started *and* ended on 13 Sep (OPD 7) or 11 Sep (OPD 4). `ended_at` = `started_at`.
4. **One distinct session per room.**

**Still arriving?** Yes, as of the read. Each room's newest window, grid 12:45 IST, was **inserted at 12:50:30 / 12:51:08 IST**, 2–3 minutes after the 12:48 operator reading, and is still `open`. A window row is inserted only when the evaluator runs on a session with chunks covering that slot.

## Reconciling the three accounts — all three are true about different things
- **`scribe_day_report` 14 Sep → `sessions: []`:** correct if it lists sessions *started* that day. Both sessions started days ago. (INFERRED from the result; I did not read that tool's code.)
- **`scribe_diff_room` → `recording: false`, `recording_session_id: null`, `last_piece_at: null`, `audio_recorded_ms: 0`:** correct if it keys on a session whose status is `recording`. Both sessions are `ended`, so there is no current session, and the per-session figures are empty. (INFERRED; tool code not read.)
- **This table:** the tape is still landing pieces today into those `ended` session rows, and windows are being written from them.
- **P3's "recorded continuously today" was read from the grid starts, not only `closed_at`.** P3 §1 quoted `min_window_start 2026-09-14 01:00 UTC` (06:30 IST). This table confirms it window by window.
- **The defect is where the accounts disagree.** Pieces keep arriving for rooms V stopped, and every operator view that keys on the session row reports them as not recording. The near-zero mic peak fits an empty room on a holiday being captured regardless.

## §2 — which line set `closed_at` on these rows
**All writers of the column** (`grep -rn closed_at lib app scripts db apps`):
- `lib/bench-window.ts:379`, inside `evaluateAndWriteWindows`;
- `db/migrations/0068_rebind_cardiology_and_spare_device.sql:112`, a one-off rebind recorded as version 68 long before today.

No reaper, `resume-processing` or backfill writes it.

**`evaluateAndWriteWindows` has two callers:**
- `app/api/bench/chunks/route.ts:240`, run after every verified chunk;
- `app/api/admin/bench/windows/route.ts:107`, a manual admin POST.

**These rows went through the chunk route — `bench/chunks/route.ts:240 → bench-window.ts:379`.** Evidence:
- **Two writes per window, 10 minutes apart.** The row was inserted `open` (`bench-window.ts:358`, `ON CONFLICT DO NOTHING`) about 5½ min into its slot, then closed about 10 min later, 48 times without exception. An admin POST inserts and closes a complete slot in the same pass (`created→closed` ≈ 0), and would need a person pressing it every 5 minutes for 6 hours.
- **The 5-minute evaluator cadence** matches piece-by-piece uploads: the first piece covering a slot inserts it, and the piece completing it closes it.
- **The room_day dated 2026-09-14** exists for both rooms. The chunk route opens it (`ensureRoomDayOpen`, `chunks/route.ts:230`); the admin POST only reads existing days — `evaluateAndWriteWindows` looks a day up and never creates one.
- **Limit:** I did not read `bench_chunk`, which is outside this order's one table. Upload timestamps there would make this direct rather than inferred from window writes.

## Flags
- **P4-1 — the defect is on the kiosk side and in the operator views, not in the drain.** Stopped rooms are still uploading at 12:51 IST, into sessions stamped `ended` at their own start. Next evidence to get: `bench_chunk` upload times for `bs_tt6xhqxt` / `bs_3rmj9amg`, and the kiosk's stop path.
- **P4-2 — the drain's age gate behaves as an audio-recency filter on these rows** (gap about 15–16 min). The auto-drain would still pick them up if Transcript were turned on; both rooms have it **off**.
