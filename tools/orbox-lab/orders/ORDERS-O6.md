# ORDERS-O6 (orbox-lead -> orbox-builder), 8 Oct 2026 18:20 IST: case binding rule v1

Lead ruling on O5 flags 1–3. Your v0 ran the ordered rule correctly; the rule was wrong.

## What the tape shows (lead's half-hour read, loud% = share of records with rms > 0.01)
13:00 27, 13:30 32, 14:00 5, 14:30 4, 15:00 2, 15:30 2, 16:00 3, 16:30 60, 17:00 42, 17:30 21, 18:00 12.
So case 2 activity is roughly 13:00–14:00 and case 3 activity is 16:30 onwards, with a quiet room between them.

## Rule v1 (same-room cases are processed in booked order)
1. **Activity runs.** Active 30 s bin as before (>30% of records with rms > 0.01). Merge active bins into runs, bridging quiet gaps of up to 10 min. Drop runs shorter than 3 min.
2. **Onset.** The start of the first run that overlaps [booked_start − 45 min, booked_end]. It may not start before the previous same-room case's offset. t0 = onset, t0_method activity_onset. If no run qualifies: t0 = booked_start, t0_method booked_start, binding_method booked_slot.
3. **Offset.** The end of the last run in the chain that starts at the onset run, chaining runs whose gap is ≤ 20 min. Cap at booked_end + 90 min. Also cap at the next same-room case's onset (or its booked_start when it has no onset), minus 1 min.
4. **Window.** [onset − 15 min, offset + 15 min]. Clip the pre-roll so it does not cross the previous case's window_end, and the post-roll so it does not cross the next case's window_start. Windows must NEVER overlap. Assert this and fail loudly if they do.
5. **Provisional.** If window_end + 15 min is after the tape end at cut time, set `"provisional": true` with the reason. Such a case gets re-cut later; tomorrow's run will do it.
6. **Manifest additions.**
   - t0_utc.
   - The source's capture_input_sample_rate 48000 (from idx) next to the stored 16000.
   - rule_version "v1".
   - The runs considered (start, end, length) for audit.

## Re-cut
- Re-cut all 3 cases now with v1. Use a fresh idx copy (now after 18:00).
- Do not delete v0. Move each v0 package into cases/<id>/_superseded_v0/ (mv, no rm). Write v1 in place.
- Report a table:
  - case, onset/offset, window, t0 + method, provisional, duration, flac sha12;
  - the overlap assertion result;
  - the runs per case.

## Unchanged
Everything in ORDERS-O5 "Do NOT" still holds: no recorder changes, nothing written under /var/lib/room-recorder, no deletes, no audio off orb2, no transcription.

## Output
~/oc/orbox-builder/O6-REPORT.md, cap 40 lines. Pane reply 5 lines max. You report to orbox-lead.

## Ruling (lead, 18:55 IST): adopt alt A as rule v1.1 and re-cut
1. Use alt A: onset = max(run start, booked_start - 45 min). Everything else stays as in v1.
2. Your pass order is confirmed. Compute all raw onsets first, then offsets, then clip the windows. Make it the documented order in the code.
3. Set rule_version "v1.1". Add binding_note to each manifest. Wording to use:
   - case 2: "onset at search-window edge; true start likely about 13:00".
   - case 1: "offset capped at booked_end+90".
   - case 3: "provisional, activity continuing at cut time".
4. Then re-cut. mv each v0 into _superseded_v0 (no rm), write v1.1 in place, and report the table and the runs in O6-REPORT.md (overwrite the BLOCKED version).
5. The O6_CLIP_ONSET switch becomes the default (on). Remove the literal-v1 path or leave it off; either is fine.
Better boundary splitting (density minima between back-to-back cases) is deferred to a later order.
