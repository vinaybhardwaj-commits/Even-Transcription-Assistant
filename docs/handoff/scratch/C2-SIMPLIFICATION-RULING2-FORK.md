# C2 simplification — why Ruling 2 was NOT implemented (scratch)

Ruling 1 is done and pushed (2f5189a). Ruling 2 stopped on a verified dependency the brief did
not account for.

## The legacy pass is the SOLE writer of three tables, not one
`runRoomDiarizePass` (lib/stt/diarize-job.ts) has exactly one production caller:
app/api/admin/diarize-windows/route.ts:69. It writes:

| table | writer | production reader |
|---|---|---|
| room_turn_speaker   | bindTurns, diarize-job.ts:390   | none (C2's reader is on the job path) |
| room_diarize_window | diarize-job.ts:228              | app/api/admin/speaker-calibration/route.ts:73 |
| speaker_cluster     | writeClusters, diarize-job.ts   | lib/brain/state.ts:447 |

The ruling targets the first row. Pointing the route at `diarize_window` jobs removes the only
caller of all three writers, so the calibration route and the brain's speaker_cluster read would
both go silently empty — success-shaped emptiness, the defect class this slice keeps meeting.

## It also contradicts a KEEP item
"safeRead's required sink at all three call sites" — the three call sites are the bench_window
scan, the speaker_cluster read inside writeClusters, and the turn-cue read inside bindTurns. Ruling
2 deletes the host of two of them.

## Options, not decided here
A. Delete the whole pass. Route enqueues. Loses safeRead (KEEP), the calibration data source and
   the brain's speaker_cluster writer. Needs an explicit ruling that both readers may go dark or
   move to the job path.
B. Route enqueues diarize_window jobs for the real pass; `?dry=1` keeps calling the pass HEAD
   (diarize + store room_diarize_window) so calibration still has data; delete bindTurns and
   bindTurnsToSpeakers only. The route then no longer writes room_turn_speaker (the ruling's
   literal wording) but still writes room_diarize_window in dry mode, writeClusters/speaker_cluster
   becomes unreachable and must be ruled on, and safeRead survives at one call site, not three.
C. Move room_diarize_window and speaker_cluster writes onto the diarize_window job, then delete the
   pass. Most coherent end state, and it is ADDING machinery in a deletion round — so not mine.
