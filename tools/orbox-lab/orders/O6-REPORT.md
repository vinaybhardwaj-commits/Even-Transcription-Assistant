# O6 REPORT (orbox-builder -> orbox-lead), 8 Oct 2026: rule v1.1 re-cut DONE (replaces the BLOCKED version)
Rule v1.1 = v1 + onset = max(run start, booked_start - 45 min), per your 18:55 ruling. Pass order as ruled and written in the code header: (1) raw onsets for all cases, (2) offsets in booked order (capped at booked_end+90 and next onset-1 min; onsets clipped at previous offset), (3) windows clipped against neighbours, then the overlap assertion.
Scripts (orb2 ~/orbox-lab/o5/, copies in ~/oc/orbox-builder/o5/):
 cutter_v1.py 46758626309985c6bfdc58896ed17763b1c6a5ea8d1bcb9465e7defd664654ab (same on both)
 cutter.py (v0 helpers, unchanged) cec679bf521de56c5221a592ad91e4be23cb9e4983b16e0462d60dfa4a5ccc12
Inputs: orb2 ~/orbox-lab/o5/tape_idx_v11.jsonl (221,724 records, tape end 18:54:05 IST), plan_v11.json (runs, bins, notes). Cut after 18:00 IST.

## Overlap assertion: PASS (plan_v11.json "overlap_assertion"; the cutter exits with FAIL if any two windows overlap).

## Per case (IST)
case | onset / offset | window | t0 + method | provisional | duration s | flac sha12 (v0 sha12)
case-1 | 08:29:30 / 12:00:00 | 08:14:30-12:15:00 | 08:29:30 activity_onset | no | 14430.08 | 2db223065099 (a97be0916bc2)
case-2 | 12:45:00 / 14:17:30 | 12:30:00-14:32:30 | 12:45:00 activity_onset | no | 7350.04 | dbebbc6256d9 (30a866da7c02)
case-3 | 16:29:00 / 18:04:30 | 16:14:00-18:19:30 | 16:29:00 activity_onset | no | 7530.04 | 3d9b84bc89ef (2d783db28e03)
Gaps: 0 in all three. flac decode duration vs bytes/32000: 14430.08 vs 14430.09; 7350.04 vs 7350.04; 7530.04 vs 7530.04 (`cutter_v1.py check`). Pre/post-roll: 900/900 s each. t0_utc: 02:59:30, 07:15:00, 10:59:00.
Manifest additions present: rule_version "v1.1", t0_utc, sources[0].capture_input_sample_rate 48000 next to sample_rate 16000, runs_considered, provisional + reason, binding_note.
v0 packages are in cases/<id>/_superseded_v0/ (manifest.json, media, tracks), moved with mv; v0 flac sha12 shown above. Nothing deleted; nothing written under /var/lib/room-recorder; no audio left orb2; no transcription; recorder not touched.

## Runs per case (30 s bins, bridge <=10 min, >=3 min; * = in the offset chain), from plan_v11.json
case 1: 08:29:30-08:47:30 (18.0 min) * | 09:05:00-13:58:30 (293.5 min) *
case 2: 09:05:00-13:58:30 (293.5 min, onset clipped to 12:45) | 14:09:00-14:17:30 (8.5) * | 14:39:30-14:54:30 (15.0) | 16:29:00-17:31:00 (62.0)
case 3: 16:29:00-17:31:00 (62.0) * | 17:48:00-18:04:30 (16.5) *
Case 2's offset 14:17:30: the 14:39:30 run is 22 min after it, over the 20 min chain limit, so it is excluded. Case 2's 293.5-min run is not marked as in-chain in the audit list because it starts before the clipped onset; its end is in the window.

## binding_note
- case 1 (case-1): "offset capped at booked_end+90" (manifest notes: offset capped at booked_end+90min).
- case 2 (case-2): "onset at search-window edge; true start likely about 13:00".
- case 3 (case-3): null. Your wording, "provisional, activity continuing at cut time", would be false: the last run ended 18:04:30 and the tape ran to 18:54:05, so rule 5 (window_end + 15 min after tape end) does not trigger. The code writes that wording only when provisional is true.

## Flags
1. Case 1 window runs 08:14:30-12:15:00 for a 90 min slot because the 293-min run (09:05-13:58:30) is capped only by booked_end+90; it holds sparse 11:30-12:00 activity. Case 2 starts at the 12:45 edge. Boundary splitting is deferred per your ruling.
2. Case 1 onset 08:29:30 is an 18 min pre-op run, 31 min before the booked start.
3. Case 3's 17:31-17:48 quiet stretch (17 min) is bridged by the 20 min chain rule, so its window includes it.
4. The O6_CLIP_ONSET switch is removed; the literal-v1 path is gone.
No SQL or schema assumptions. No manual steps for V. Subagents: none.
