# ORDERS-O5 (orbox-lead -> orbox-builder), 8 Oct 2026: ORB2 case cutter v0

## Goal
Cut one case package per booked OT-2 case out of ORB2's continuous tape, following ORBoX PRD v0.2.1 amendment A1 (Mini ~/dev/even-or-box/docs/prd/OR-BOX-PRD-30-AUG-2026-v0.2.md: D11, §6.1, §6.4). Run it on today's 3 OT-2 cases.

## Known facts
- ORB2 = ssh alias `orb2` (user vinay, passwordless `sudo -n`). Recording is ALWAYS continuous (V ruling, 8 Oct): never stop, restart or reconfigure room-recorder.
- Tape is in /var/lib/room-recorder/tape/ (owned by room-recorder, read via sudo -n):
  - tape.pcm grows at about 32,000 B/s, likely 16 kHz mono s16le. VERIFY this from the bytes and the index before relying on it.
  - tape.idx is JSON lines, one record about every 1.3 s, with byte_offset, wall_ns (epoch ns), mono_ns, samples, rms, peak, device, input_sample_rate=48000.
- Cases, from Mini ~/oc/orbox/metasurfer/ot-cases-2026-10-05_now.csv. These are BOOKED times only; no actual times exist anywhere:
  - case-1 OT-2 8 Oct 09:00–10:30 IST. Tape activity was 09:00–11:00, loudest 10:00–10:30.
  - case-2 OT-2 8 Oct 13:30–15:30 IST.
  - case-3 OT-2 8 Oct 16:00–17:30 IST.
- PRD A1:
  - Window = booked slot plus 15 min pre-roll and 15 min post-roll, refined by activity. binding_method is one of booked_slot | booked_slot+activity | mark | manual.
  - t0_method precedence: mark > activity_onset (inside slot ± pad) > booked_start.
  - Out-of-case tape is never packaged.

## Scope / allowed
- Write only to a NEW directory on ORB2: /var/lib/orbox-cases/ (create it with sudo, owner vinay, mode 750). Layout per case: /var/lib/orbox-cases/cases/<case_id>/{manifest.json, media/room_orb2.flac, tracks/activity.jsonl}.
- Script in ~/orbox-lab/o5/ on orb2 (mkdir it), with a copy in ~/oc/orbox-builder/o5/. Use python3 plus numpy if it is present on orb2; check, and do not pip install system-wide. Use flac/ffmpeg (/usr/bin/ffmpeg exists) for encoding.
- Activity rule v0, from tape.idx rms only:
  - a 30 s bin is "active" if more than 30% of its records have rms > 0.01;
  - activity_onset = the first active bin in [booked_start − 30 min, booked_end] that is followed by at least 3 active bins out of the next 5;
  - activity_offset = the last active bin, by the same rule, at or before booked_end + 90 min.
  - Window = [min(booked_start, onset) − 15 min, max(booked_end, offset) + 15 min], capped at booked ± 120 min.
  - Report the bins so the rule can be checked.
- manifest.json fields:
  - case_id, ot_room "OT-2", source_room_id <scribe_room_id>, recorder session id from status.json, booked_start/end;
  - window_start/end (IST and UTC), binding_method, t0 (IST), t0_method, pre_roll_s and post_roll_s;
  - sources [{id:"orb2_room", path, sample_rate, channels, byte_offset_start/end, clock:"wall_ns from tape.idx, NTP-synced", clock_offset_ms:0}];
  - gaps: any idx discontinuity over 2 s, listed explicitly, never padded or trimmed silently;
  - sha256 of the media file, cutter version and sha256.
- tracks/activity.jsonl: one row per 30 s bin, with t_rel_ms from t0, rms_median, active flag. Add an empty transcript placeholder only if trivial: tracks/transcript.jsonl with no rows, schema t_rel_ms, t_end_ms, role, text, role default "unknown".

## Timing
- Start any read of tape.pcm only AFTER 18:00 IST on 8 Oct, when today's OT-2 cases are over. Writing and testing the code on a copy of tape.idx is fine before then.
- Keep IO gentle (nice -n 10, ionice -c3).

## Verify
1. Byte layout: decode 10 s at a known idx record. Confirm the sample rate and format, and that duration matches samples/bytes.
2. For each case: window, onset/offset, t0_method, bytes cut, duration, flac sha256, and gaps found.
3. flac decodes, and its duration equals window length minus any gaps (± 1 s).

## Do NOT
- Stop, restart or reconfigure room-recorder or room-bench.
- Write into /var/lib/room-recorder.
- Delete anything.
- Copy audio off ORB2.
- Send audio to any service.
- Transcribe.
- Message V.

## Output
~/oc/orbox-builder/O5-REPORT.md, cap 50 lines: byte-layout proof, a per-case table, script sha256, flags. Pane reply 5 lines max. You report to orbox-lead.

## Addendum (lead, checked 12:50 IST)
orb2 has NO numpy and no flac binary. Use the python3 stdlib (array, statistics, json) and /usr/bin/ffmpeg for FLAC encoding. Do not install packages system-wide. ssh orb2 is now allowed in your settings.
