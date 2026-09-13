# C2 fix round — Builder notes (scratch)

## Slicing (D4)
SLICE_MS 120_000. 120*1.5*1000+45_000 = 225_000 vs LEASE_MS 240_000 → 15 s margin.
900 s window → sliceBounds(0,900_000) = 8 slices (7x120 s + 1x60 s) → 8 `slice` steps + 1 `stitch` step.
Each slice joins its own sub-clip via callJoinService (same mechanism as the 30 s language probe),
calls /diarize with batch_threshold 0.65, writes its rows, and appends its speakers to
room_diarize_window.speakers_json.

## Why speakers_json and not `progress`
lib/mcp/tools/jobs.ts:45 returns `progress` to a READ-scope token. A speaker embedding is a
voiceprint (float32[192], the same shape as voice_print.centroid), so carrying it on the job row
would hand biometrics to any read token. speakers_json is a server-side column on a table that has
no MCP reader.

## Stitch
stitchSpeakers: greedy, slices in order, compare against each group's OPENER (not a running mean,
so one weak member cannot drag a group onto a different voice). Join at cosine >= 0.65.
- no usable embedding => own identity, never named
- two DIFFERENT enrolled ids inside one group => group left unnamed (the group is wrong; picking
  one would be guessing which)
- propagated confidence = min(service match, stitch cosine) — the weakest link, not the last hop

## Verification run
- straddle: turn 1000-2000, segs 0-600 idx0 (matched) / 600-1000 idx1 → role unattributed, idx 0 kept
- seam: turn 119_000-125_000 against slice 0-120_000 → role unattributed, seam_skipped 1
- reachability: 8 slices over a 900 s window each return ok and write a row (8 rows)
- 0.65: asserted on runDiarize opts AND on the stitch constant
- invariant still bites: whisper async:false→true ⇒ "expected ['whisper'] to deeply equal []"

## Not fixed
Word-level timings: whisper verbose_json returns them, `stt_turn` cues persist only segment bounds.
The straddle rule now REFUSES rather than smears, which is correct but costs attributions that word
timings would keep. Changing the cue payload is a separate piece of work.
