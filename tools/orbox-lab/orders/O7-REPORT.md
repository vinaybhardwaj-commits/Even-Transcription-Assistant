# O7 REPORT (orbox-builder -> orbox-lead), 8 Oct 2026: cutter v2 (rule v2), OT-2 re-cut DONE; commit/push NOT DONE (blocked)
## R5 flag 1: the 18:15:40 `sudo python3 -`
My session record has no `sudo python3 -` command, and my cutter reads only through `sudo -n cat` and `sudo -n ionice/nice dd` (cutter_v1.py cut, 18:0x-18:5x). You told me later it was your own read-only rms scan of tape.idx. I have nothing to add. I have run no root python on orb2.
## Code
orb2 ~/orbox-lab/o7/cutter_v2.py, copy ~/oc/orbox-builder/o7/cutter_v2.py, sha256 254389fbce8417a6ddf052790fe590a0c38ff70603ed8b318929fecd10885373 (same on both). Stdlib + ffmpeg, self-contained. `cut --date --room --bookings [--dry-run] [--idx]`, `check --date --room`. No schedule installed.
Bookings extract: 4 columns, rows of 2026-10-08, orb2 ~/orbox-lab/o7/bookings-2026-10-08.csv (no names, no procedures). Fresh idx snapshot 22:43:26 IST, 232,516 records, tape end 22:43:25. Dry run, then cut on the same snapshot.
## Dry-run plan (IST; d = 5-min block density)
case 1: segment 07:00:00-11:12:30; boundary_next 11:12:30 (min d 0.00, stretch 11:10-11:15, search 10:30-13:30); onset 08:30:00 offset 11:10:00; window 08:15:00-11:12:30.
case 2: segment 11:12:30-15:42:30; boundary_prev 11:12:30; boundary_next 15:42:30 (min d 0.00, stretch 15:35-15:50, search 15:30-16:00); onset 11:15:00 offset 14:00:00; window 11:12:30-14:15:00.
case 3: segment 15:42:30-20:30:00 (booked_end+180); onset 16:30:00 offset 18:05:00; window 16:15:00-18:20:00.
Overlap assertion PASS. Full output: ~/oc/orbox-builder/o7/dryrun.txt (includes runs with clipped bounds and in_chain).
## Table (all t0_method activity_onset, binding booked_slot+activity, provisional false, gaps 0)
case | bound prev / next (d) | segment | onset / offset | window | t0 | duration s | flac sha12
case-1 | - / 11:12:30 (0.00) | 07:00:00-11:12:30 | 08:30:00 / 11:10:00 | 08:15:00-11:12:30 | 08:30:00 | 10650.06 | 2e758787f18f
case-2 | 11:12:30 (0.00) / 15:42:30 (0.00) | 11:12:30-15:42:30 | 11:15:00 / 14:00:00 | 11:12:30-14:15:00 | 11:15:00 | 10950.07 | aa722fee8f54
case-3 | 15:42:30 (0.00) / - | 15:42:30-20:30:00 | 16:30:00 / 18:05:00 | 16:15:00-18:20:00 | 16:30:00 | 7500.04 | b871b5f26dfb
`check` PASS 3/3: flac sha256 equals media_sha256; decode 10650.06 / 10950.07 / 7500.04 s equal bytes/32000; activity rows 355 / 365 / 250, all with t_abs and t_rel_ms; meta.json present. Second `cut` run: all 3 "unchanged, nothing done".
Old packages: mv'd into cases/<id>/_superseded_v1_1/ (manifest.json, media, tracks); _superseded_v0/ untouched. Day file: /var/lib/orbox-cases/days/2026-10-08-OT-2.json.
## Orphan list (d >= 0.3, between 07:00 and 20:30, in no window)
1 block: 18:55 (d 0.30). Case 3's chain ended 18:05; the 18:52:30-19:01:30 run starts 47.5 min later, over the 20 min chain limit.
## Commit and push: NOT DONE
Writing cutter_v2.py into ~/dev/eta-wt-orbox-lab/tools/orbox-lab/builder/o7/ and ORDERS-O7.md into orders/ worked, and `gitleaks dir tools/orbox-lab` printed "no leaks found" (0). The next call, `git commit` + `git push origin orbox/tooling-import` to the public ETA repo, was denied by the auto-mode classifier (Data Exfiltration, then Out-of-Place Publication). Even a following `git status` was denied. I did not retry or work around. I do not know whether the commit was created. Files in the worktree: builder/o7/cutter_v2.py, orders/ORDERS-O7.md (untracked or committed, unverified). Needs a permission rule for git commit/push on that worktree and branch; tell me and I commit and push (and add O7-REPORT.md to orders/).
## Flags
1. Case 2 onset is 11:15, not about 12:20. The 293.5 min run (09:05-13:58:30) is split at 11:12:30, and a block with d >= 0.3 inside it at 11:15 exists, so case 2 carries about 1 h of case 1's sparse tail (R5: sparse 11:10-12:15). Rule as ordered; it needs a stricter onset (for example 3 consecutive blocks >= 0.3) if the true start should be about 12:20.
2. Case 1 boundary is at the earliest d = 0.00 block (11:10-11:15). Many blocks tie at 0.00 and each is a one-block stretch, so "earliest" decides. R5's 11:35 would have been another tie.
3. Case 3 window_end 18:20 and offset 18:05 are unchanged in effect from v1.1; its onset moves from 16:29:00 to 16:30:00 (block aligned). Onset and offset are now 5-min block aligned.
4. status.json on orb2 no longer has `session_id` (keys: pending_piece_count, state, updated_at). The cutter takes `recorder_session_id` from the previous manifest (<recorder_session_id>) when status has none. The recorder has not restarted (NRestarts=0, since 5 Oct 14:47:13).
5. room_uid is null: the 4-column extract has no ot__ot_room_uid. meta.json source is the extract file name, bookings-2026-10-08.csv, not the Metabase CSV name.
6. A case with no qualifying block gets a window of booked slot +-15 min inside its segment (the order does not say). Not exercised on 8 Oct.
7. Bin attribution follows v1.1 (rms in the bin of the chunk-end wall_ns); R5 says the rms covers the chunk before it, a shift of at most 1.3 s. The 30 s bins are unchanged.
No SQL or schema assumptions. Nothing deleted, nothing under /var/lib/room-recorder, no audio left orb2, no transcription, no root python, recorder untouched. Subagents: none.

# v2.1 section (lead ruling 23:05 IST): rule v2.1, re-cut DONE; commit only (no push)
Script: orb2 ~/orbox-lab/o7/cutter_v2.py = ~/oc/orbox-builder/o7/cutter_v2.py, sha256 cc22b72c1897e3a75a880844176861834ca5af9d2f0ca1e1133ba33026479f1c (VERSION o7-cutter-v2.1, rule_version "v2.1"). Fresh idx snapshot 22:56:59 IST, 233,154 records, tape end 22:56:58. Dry run (o7/dryrun_v21.txt), then cut on the same snapshot.
Changes: (1) onset = first streak of 3 consecutive 5-min blocks with d >= 0.3, inside one run, inside the segment; offset unchanged. (2) record binned by chunk start = wall_ns - (samples - previous samples)/16000 s; first record and chunks outside (0, 5] s use wall_ns. (3) no-onset rule is in the code header. (5) manifest recorder_session_id_source ("previous manifest" here; status.json has no session_id). (6) room_uid read from column ot__ot_room_uid if present; the source CSV has none, so null. Ties unchanged.
## Table (IST; all activity_onset, booked_slot+activity, provisional false, gaps 0; boundaries and segments unchanged from v2)
case | bound prev / next (d) | segment | onset / offset | window | t0 | duration s | flac sha12
case-1 | - / 11:12:30 (0.00) | 07:00:00-11:12:30 | 09:05:00 / 11:10:00 | 08:50:00-11:12:30 | 09:05:00 | 8550.05 | b0c797c97b85
case-2 | 11:12:30 (0.00) / 15:42:30 (0.00) | 11:12:30-15:42:30 | 12:20:00 / 14:00:00 | 12:05:00-14:15:00 | 12:20:00 | 7800.05 | 26ce8eadeae1
case-3 | 15:42:30 (0.00) / - | 15:42:30-20:30:00 | 16:30:00 / 18:05:00 | 16:15:00-18:20:00 | 16:30:00 | 7500.04 | b871b5f26dfb (same as v2)
Overlap assertion PASS. `check` PASS 3/3 (sha256 equal; decode 8550.04 / 7800.04 / 7500.04 s vs bytes/32000 8550.05 / 7800.05 / 7500.04; activity rows 285 / 260 / 250 with t_abs; meta.json present). Second `cut`: 3 x "unchanged". v2 packages are in cases/<id>/_superseded_v2_2257/ (mv); _superseded_v1_1 and _superseded_v0 untouched.
Case 2 onset is now 12:20, matching R5's busy-from-12:20 reading. Case 1 onset moved from 08:30 to 09:05.
## Orphans (d >= 0.3, between 07:00 and 20:30, in no window): 6 blocks
08:05 (0.30), 08:30 (0.30), 11:15 (0.50), 11:30 (0.30), 11:45 (0.40), 11:50 (0.40). The v2 orphan at 18:55 (d 0.30) no longer appears; I did not check why.
Flags: (a) the 08:29:30-08:47:30 pre-op run (18 min, 08:30 d 0.30) is outside case 1's window; the 3-block streak rule skips it. (b) 11:15-11:50 is case 1's sparse tail after the 11:12:30 boundary, now in no window (about 40 min, d 0.3-0.5). (c) The bin shift moves bins by up to 1.3 s; case 3's boundaries are unchanged.
R5 flag 1 closed per ruling (the 18:15 root read was the lead's).
