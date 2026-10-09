# ORDERS-R5 (orbox-lead -> orbox-refuter), 8 Oct 2026: refute the ORB2 case cutter (O5 + O6, rule v1.1)

## Goal
Independently confirm or refute that the three 8 Oct OT-2 case packages on ORB2 are correct, and that the cutter did no harm to the live recorder.

## Inputs
- Builder reports: ~/oc/orbox-builder/O5-REPORT.md and O6-REPORT.md. Orders: ORDERS-O5.md and ORDERS-O6.md, including the 18:55 ruling (rule v1.1 = alt A).
- On orb2:
  - packages under /var/lib/orbox-cases/cases/<case_id>/: manifest.json, media/room_orb2.flac, tracks/;
  - v0 under _superseded_v0/;
  - builder script ~/orbox-lab/o5/cutter_v1.py.
- Tape is in /var/lib/room-recorder/tape/{tape.pcm, tape.idx}, readable with `sudo -n`.
- ssh alias `orb2` (user vinay). One action per Bash call.

## Rules
Use your OWN scripts in a new dir orb2 ~/orbox-lab/r5/. Do not import or run the builder's cutter. Python stdlib plus /usr/bin/ffmpeg only; orb2 has no numpy.
Never stop, restart or reconfigure room-recorder or room-bench. Never write under /var/lib/room-recorder or /var/lib/orbox-cases. No deletes. No audio leaves orb2. No transcription.

## Checks
- **P1 Byte layout.** Re-derive the tape.pcm format from the bytes and the idx (sample rate, width, channels, how byte_offset relates to samples and wall_ns). Decode at least 3 spots and compare chunk rms with the idx rms.
- **P2 Windows.** From a fresh idx copy, implement rule v1.1 yourself (ORDERS-O6 plus the ruling) and recompute runs, onset, offset, t0, t0_method, window and provisional for all 3 cases. Compare each with its manifest (±30 s tolerance). Assert that no two windows overlap.
- **P3 Media.** For each case:
  - sha256 of the flac matches the manifest;
  - an ffmpeg full decode gives a duration equal to the window minus declared gaps (±1 s);
  - the decoded first and last 10 s match the raw tape.pcm bytes at the manifest byte offsets (compare sample-exactly, or by rms to 4 digits if FLAC is lossless).
- **P4 Manifest.** The fields required by ORBoX PRD v0.2.1 A1 (§6.1/§6.4, Mini ~/dev/even-or-box/docs/prd/OR-BOX-PRD-30-AUG-2026-v0.2.md) are present: case_id, window_start/end in IST and UTC, binding_method, t0, t0_method, sources with offsets, gaps, sha256, rule_version. List anything missing.
- **P5 No harm.**
  - room-recorder was active throughout: journalctl -u room-recorder since 17:30 IST shows no restarts.
  - tape.idx has no gap over 2 s between 17:55 and 19:30 IST.
  - Nothing under /var/lib/room-recorder has an mtime or owner change attributable to vinay or the cutter.
  - The v0 packages exist under _superseded_v0 (moved, not deleted), with their original sha256 from O5-REPORT.
- **P6 Sanity of the binding.** For each case, give the 5-minute activity density profile from booked_start − 60 min to booked_end + 120 min (fraction of active 30 s bins), and say in one line whether the window plausibly covers the operation. You may flag a better split rule, but do not judge it as part of the verdict.

## Output
~/oc/orbox-refuter/R5-VERDICT.md, cap 60 lines: P1–P6, each CONFIRMED / REFUTED (with numbers) / UNVERIFIED, then a 3-line overall verdict, then flags. Raw output stays in orb2 ~/orbox-lab/r5/. Pane reply 5 lines max. Post a one-line bus note to orbox-lead. You report to orbox-lead.
