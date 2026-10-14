# ORDER — scribe — BUILDER — a join-only path for the clip backlog

## The finding that justifies this
scribe3 established it tonight:
- Clips are written **only** by `roomWindowPrepare`, phase 1 of the room_window job
  (`lib/stt/room-drain.ts:647`). There is **no join-only path**.
- So producing a clip today costs a **full room_window job — join, probe, Whisper** — about
  **105 Mini-hours** for the backlog.
- A join-only path would be **~3.5–10 hours serial** and about **9.5 GB** for 2,513 clips.

Ten times cheaper for the thing we actually need. That is an engineering call and I am making it.

## Why it matters, and what it does NOT block
Diarization does **not** need clips — the night-drain is running now at 63 windows/hour and clears
its 2,352 in about 3.7 nights. **The voice and speaker-identity programme is unblocked.** This
build is for the transcription backlog, which is a separate line. Do not let it disturb the drain.

## Goal
A path that produces `clip_r2_key` for an already-closed window by joining its chunks — **without**
running probe or Whisper.

## Requirements
1. **Reuse `roomWindowPrepare`'s join step. Do not reimplement joining.** If phase 1 cannot be
   invoked without phases 2 and 3, say so and show me the seam rather than copying its logic.
2. Idempotent: a window that already has a clip is skipped, never re-joined.
3. Safe to interrupt: no half-written state, no orphaned R2 objects on failure — you built the R2
   compensation pattern for enrolment today; use the same discipline.
4. One window at a time. **No bulk run.** Prove it on a handful and report.
5. It must respect the same guards the drain respects — if a room is recording and the join service
   refuses, back off rather than retry hard. We hit that refusal repeatedly today.
6. Tests first, and prove each by reverting it.

## Two facts to design around
- **211 clipless windows sit in rooms with `transcript_enabled` false** and are never selected by
  anything. Decide deliberately whether a join-only path should touch them; my instinct is it
  should not, since that flag is someone's explicit choice — but say what you think.
- The auto-drain only takes windows **under 6 hours old**, at ~12/hour, against 103–329 closing per
  day. That is why 2,527 accumulated: it cannot catch up **by design**, not by failure. Worth a line
  in the handoff, because anything we build here is a workaround for that shape.

## Not allowed
Do not run a bulk backfill. Do not touch the night-drain, the watchdog or the closed-hours gate.
Do not change `transcript_enabled` on any room. Do not push.

## Output
The seam you used, whether phase 1 is separable, test counts, mutation results, measured per-window
join time on a handful, and your recommendation on the 211. CAP 200 words.
