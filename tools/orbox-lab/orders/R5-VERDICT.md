# R5 VERDICT (orbox-refuter -> orbox-lead), 8 Oct 2026, on O5 + O6 (rule v1.1), ORB2 OT-2 case packages
Own script: orb2 ~/orbox-lab/r5/r5.py (sha256 22d946f3...8731), stdlib + ffmpeg only. The builder's cutter was not imported or run. Tape read only with `sudo -n dd/cat`.
Raw outputs: orb2 ~/orbox-lab/r5/p1_*.out ... p6_density.out. Idx copies taken 19:22:31 and 19:31:10 IST.

## P1 Byte layout: CONFIRMED
- 223,061 idx records (5 Oct 12:11:07 to 8 Oct 19:22:29). byte_offset = 2 × samples in every record; offsets are monotonic. 16 kHz mono s16le, 32,000 B/s (15,999.8 samples per wall s; record spacing median 1.275 s).
- Record k carries the cumulative byte_offset at the END of its chunk; its rms is for bytes [bo(k−1), bo(k)) and its wall_ns is the chunk end.
- Decoded 12 chunks at 09:30, 14:00 and 17:00: the PCM rms equals idx rms(k) to 6 digits in 12/12 (e.g. 0.013404/0.013404, 0.028678/0.028678). It never equals rms(k−1).
- Minor correction to O5: input_frames = 3 × samples is not true "in every record". 4 per-record deltas are off by −2 to +2 frames.

## P2 Windows (my rule v1.1 on a fresh idx): CONFIRMED, 0 s difference on every field
- case 1 case-1: onset 08:29:30, offset 12:00:00, t0 08:29:30 activity_onset, window 08:14:30–12:15:00. Same as manifest.
- case 2 case-2: onset 12:45:00 (09:05 run clipped at booked−45), offset 14:17:30, t0 12:45:00 activity_onset, window 12:30:00–14:32:30. Same as manifest.
- case 3 case-3: onset 16:29:00, offset 18:04:30, t0 16:29:00 activity_onset, window 16:14:00–18:19:30. Same as manifest.
- My runs match the manifests' runs_considered. Overlap assertion: no overlap (12:15:00 < 12:30:00; 14:32:30 < 16:14:00). The IST/UTC pairs are equal instants.
- Case 3 provisional = false is CORRECT. window_end + 15 min = 18:34:30, before the tape end at cut (18:54:05) and before now (19:22).
- The one run that appeared after the cut (18:52:30–19:01:30) starts 48 min after case 3's offset, past the 20 min chain limit, so case 3 does not change on fresh tape.

## P3 Media: CONFIRMED (3/3)
- The FLAC sha256 equals media_sha256 in 3/3 (2db22306..., dbebbc62..., 3d9b84bc...). ffprobe: flac, s16, 16000 Hz, 1 channel.
- Full decode: 461,762,790 / 235,201,430 / 240,961,396 bytes, each exactly byte_offset_end − start. Durations 14430.087 / 7350.045 / 7530.044 s against window − gaps of 14430 / 7350 / 7530 s (≤0.09 s).
- The first 10 s and last 10 s are sample-exact against the tape bytes at the manifest offsets (3/3).
- Stronger check: the sha256 of the full decoded PCM equals the sha256 of the tape range in 3/3 (6f49a532..., 442a919b..., ef651d3c...).
- The byte offsets map back to window_start/end within 0.0 s on the idx clock.

## P4 Manifest vs PRD v0.2.1 A1 §6.1/§6.4: CONFIRMED (required fields all present)
- Present: case_id, window_start/end _ist and _utc, binding_method, t0_ist + t0_utc, t0_method, sources[] (path, sample_rate, channels, capture_input_sample_rate, byte_offset_start/end, clock, clock_offset_ms), gaps (empty list), media_sha256, rule_version "v1.1", provisional + reason, binding_note, runs_considered, cutter version + sha256.
- Not present (not required by the A1 list, so I am noting them only):
  - tracks/activity.jsonl rows carry t_rel_ms but no t_abs. §6.1 says every sample/event has both; t_abs can be derived from t0_utc.
  - meta.json from the §6.4 folder contract is absent.
  - gaps is a bare list with no schema shown (no gap occurred).
- Activity row counts (481/245/251) equal window/30 s.

## P5 No harm: CONFIRMED, with one UNVERIFIED item (flag 1)
- room-recorder and room-bench are active. room-recorder has run since 5 Oct 14:47:13, NRestarts=0, and the journal has no entries since 17:30.
- Idx 17:54–19:31: 4,565 records, max spacing 1.30 s, 0 gaps over 2 s, 0 byte/sample mismatches, 16,000.11 samples/s.
- /var/lib/room-recorder: every file is owned room-recorder:room-recorder. Only the recorder's own files changed since 12:00 (tape.*, status.json, cursor.json, spool), with no ctime-only (chmod/chown) changes.
- sudo log since 12:00: reads only (cat idx/status, dd, find, stat, journalctl), plus mkdir/chown/chmod on /var/lib/orbox-cases at 12:50, plus one `sudo python3 -` at 18:15:40.
- v0 packages exist under each _superseded_v0/ (files dated 18:01). Their sha256 equals the v0 manifests and O5's sha12 (a97be0916bc2, 30a866da7c02, 2d783db28e03).

## P6 Binding sanity (5-min share of active 30 s bins; full profiles in p6_density.out)
- case 1 (booked 09:00–10:30): dense 09:05–11:05 (0.5–1.0), sparse 11:10–12:15 (0.0–0.5). The window 08:14:30–12:15 covers the operation, plus about 1 h of sparse tail. Plausible.
- case 2 (booked 13:30–15:30): busy 12:20–13:40 (12:20 0.9, 12:30–12:45 0.7–0.8, 13:30–13:35 0.8–1.0), quiet from 14:00 (≤0.1). The window 12:30–14:32:30 covers the busy stretch. Plausible, but the start is uncertain (flag 2).
- case 3 (booked 16:00–17:30): dense 16:30–17:15 (0.6–1.0) plus 17:50–18:00 (0.6–0.7), then quiet until 18:50. The window 16:14–18:19:30 covers both. Plausible.

## Overall
1. CONFIRMED. The three v1.1 packages are correct: my independent rule gives the same windows to the second, with no overlap. Each FLAC is a bit-exact copy of its tape byte range, the sha256 values match, and case 3 is correctly not provisional.
2. No harm found to the live recorder: no restarts, no idx gaps 17:54–19:31, no file changes outside the recorder's own writes. The v0 packages were moved, not deleted.
3. One item cannot be audited from the log (flag 1). The filesystem evidence shows it changed nothing under /var/lib/room-recorder.

## Flags (outside the verdict)
1. `sudo python3 -` ran as root at 18:15:40 (an operator account), during the v1 re-cut. Its script came from stdin, so the log does not show what it did. Ask the builder what it ran. A root script should not be needed: dd/cat cover every read.
2. Tape 12:15–12:30 (density 0.2/0.9/0.5 at 12:15/12:20/12:25) is in NO package. It falls between case 1's end and case 2's clipped start. Case 2 activity may have begun about 12:20, not 13:00 as the binding_note says. A density-minimum split (for example at 11:35, density 0.0) would package it.
3. Case 1 carries about 1 h of sparse tail (11:10–12:15). The cap at booked_end+90 sets its end, not the activity.
4. In case 2's runs_considered, the 09:05–13:58:30 run has in_chain=false although it supplies the onset. That is confusing in an audit.
5. `find /var/lib/room-recorder/tape/tape.pcm -mmin -2` ran 438 times via sudo since 12:00, about once a minute. It is read-only and looks like someone's watcher; not from this cutter as far as I can tell.
