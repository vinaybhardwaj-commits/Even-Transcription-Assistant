# O5 REPORT (orbox-builder -> orbox-lead), 8 Oct 2026: ORB2 case cutter v0
Script: orb2 ~/orbox-lab/o5/cutter.py, copy ~/oc/orbox-builder/o5/cutter.py, sha256 cec679bf521de56c5221a592ad91e4be23cb9e4983b16e0462d60dfa4a5ccc12 (same on both). Stdlib python3.14 + /usr/bin/ffmpeg. No tape.pcm read before 18:00 IST (code refuses; first read 18:01).
Outputs: orb2 /var/lib/orbox-cases/cases/<case_id>/{manifest.json, media/room_orb2.flac, tracks/activity.jsonl, tracks/transcript.jsonl (empty)}. Working files: orb2 ~/orbox-lab/o5/{tape_idx_cut.jsonl (idx copy), plan_cut.json (bins, onset/offset, gaps), plan_dev.json}.

## 1. Byte-layout proof
- Idx (219,233 records in the 18:01 copy; `cutter.py layout` on the 12:47 copy, 204,507 records): byte_offset == 2 x samples in every record; input_frames == 3 x samples; 15,999.8 samples per wall second (median); record spacing median 1.275 s. So tape.pcm is 16 kHz mono s16le, 32,000 B/s. input_sample_rate 48000 (7 records have none).
- PCM decode: 10 s at idx record 194473 (byte_offset 7933448014) gave 320,000 B = 160,000 samples = 10.000 s. Per-chunk rms from the PCM matches the rms stored in the NEXT idx record to 5 digits (0.00426/0.00426, 0.00437/0.00437, 0.00462/0.00462, 0.00450/0.00450, 0.00488/0.00488). Source: `cutter.py verify` output. A record's byte_offset is bytes written before its wall_ns.

## 2. Per case (IST; manifests and plan_cut.json)
case | window | onset / offset | binding | t0, method | bytes cut | duration s | gaps | flac sha256 (12)
case-1 (09:00-10:30) | 08:45:00-12:10:00 | 09:05:00 / 11:55:00 | booked_slot+activity | 09:05:00 activity_onset | 393,602,392 | 12300.07 | 0 | a97be0916bc2
case-2 (13:30-15:30) | 12:45:00-17:15:30 | 13:00:00 / 17:00:30 | booked_slot+activity | 13:30:00 booked_start | 519,363,016 | 16230.09 | 0 | 30a866da7c02
case-3 (16:00-17:30) | 15:45:00-18:01:09 | 16:29:00 / 17:59:00 | booked_slot+activity | 16:29:00 activity_onset | 261,409,914 | 8169.06 | 0 | 2d783db28e03
Full flac sha256 and byte offsets are in each manifest.json. Activity rows (30 s bins in window): 410, 541, 273. pre_roll_s = t0 - window_start (1200, 2700, 2640); post_roll_s = window_end - max(booked_end, offset) (900, 900, 129).
Verify 3: ffmpeg full decode duration vs bytes/32000: 12300.07 vs 12300.07; 16230.09 vs 16230.09; 8169.05 vs 8169.06. Window length minus gaps (0 gaps) is within 0.05 s.
Recorder session id in manifests: <recorder_session_id> (status.json). room-recorder untouched; nothing written under /var/lib/room-recorder; nothing deleted; no audio left orb2; no transcription.

## 3. Flags (the rule as ordered produced these; I did not change the rule)
1. The windows are long and overlap. Case 1 window is 3 h 25 min for a 90 min slot because sporadic activity at 11:30-12:00 meets the offset rule (15-min medians in plan_dev.json: active bins 5-8 of 30 at 11:15-12:15). Case 2 offset 17:00:30 is caused by case 3's activity, so case 2's window (12:45-17:15:30) overlaps case 3's (15:45-18:01:09) for 1.5 h. That tape is packaged in both cases. "Out-of-case tape is never packaged" is not met in the overlap. I need a ruling (for example: cap offset at next booked start).
2. Case 3 window_end is clamped to the tape end (18:01:09) because activity was still present at 17:59; post_roll is 129 s, not 900 s. Manifest note: window_end_after_tape_end.
3. Case 2 onset 13:00 is 30 min before the slot; I read "slot +/- pad" as pad = 15 min, so t0_method fell to booked_start. Case 3 onset 16:29 is 29 min after the booked start; t0 = 16:29. The rule picks the first active bin followed by 3 of 5; it ignores earlier sparse activity.
4. Your note said case 1 activity was 09:00-11:00; the rule gives onset 09:05, offset 11:55.
5. No mark exists in the data, so t0_method "mark" and binding_method "mark"/"manual" were not exercised.
6. manifest times: booked/window fields are *_ist and window also *_utc; t0 only IST (PRD field names not checked beyond the order's list). Source sample_rate 16000, channels 1; the 48 kHz input rate is not recorded in the manifest.
7. Idx gaps over 2 s: 7 in the whole idx, none inside any window. Gap check also flags byte/sample mismatch; none either.
8. Directory modes: /var/lib/orbox-cases and cases/ are 750 vinay. Subfolders and files created by the script are 775/664 (umask), inside the 750 parent.
9. Case 1 dry run on the 12:47 idx copy matched the final plan exactly (same window).
No SQL or schema assumptions. No manual steps for V. Subagents: none.
