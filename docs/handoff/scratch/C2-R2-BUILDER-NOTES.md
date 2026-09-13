# C2 fix round 2 — Builder notes (scratch)

## Seam loss: NOT MEASURABLE on live data. Evidence, not an excuse.
Ran the aggregate's inputs through the Scribe MCP door, piping every response into a script that
emits counts only — no transcript text entered the transcript at any point.
- `scribe_list_cues type=stt_turn include_payload=true limit=500` across 6 rooms
  (cardiology-opd-gh4a, opd-7-y74w, opd-3-kjpf, room-4-1, opd-6-webcam-only, home-office)
  x 7 IST dates (2026-09-12, -11, -10, -09, -05, -01, 2026-08-25): **0 stt_turn cues, every
  room, every date.**
- Control, same door, same days, no type filter: mic_primary_lost 1, mic_backup_unavailable 2.
  So the door, the auth, the room slugs and the dates are right; the table has no turns.
This is consistent with the standing position that STT is on hold: nothing has drained, so no
`stt_turn` cue has ever been written for these days. The denominator is zero, so a percentage
would be invented. Reporting the zero.

The analytic model from the R2 notes stands unchallenged and is the only number available:
P(cross) = E[d]/L for turns, (mean/L)(1+CV^2) for speech seconds. At L=120 s and a 4-6 s mean that
is ~3-5% of turns and ~5-10% of speech seconds.

## Snapping — measured on synthetic input with a known answer
Turns every 20 s, 15 s long, 900 s window: 8 slices, longest 120 000 ms, ZERO cuts land inside a
turn. One continuous 900 s turn (nothing to snap to): falls back to 8 hard cuts, none over the cap.

## Branded types — the call site it rejected
Before the brand, `diarizeSlice({... slice})` accepted `SliceBound` with `start_ms/end_ms` and
`loadWindowTurns(roomDayId, sliceStart, sliceEnd)` compiled happily while comparing window bounds
to slice bounds. After:
    lib/jobs/kinds/diarize-window.ts(115,74): error TS2739: Type 'SliceBound' is missing the
    following properties from type '{ index: number; start: SliceStartMs; end: SliceEndMs; }'
and passing a window bound where a slice bound is wanted is now TS2345.

## Stitch self-check
Counts the `speakers_json.slices[].index` entries actually stored, compares to the planned slice
indices, and on any gap returns failWith naming the count and the missing indices. The reported
`slices` is the OBSERVED entry count; `slices_planned` is carried separately so the two can never
be confused again.
