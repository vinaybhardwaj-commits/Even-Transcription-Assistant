# ORDERS-O7 (orbox-lead -> orbox-builder), 8 Oct 2026 22:55 IST: case cutter v2 (rule v2)

## Goal
Replace rule v1.1 with rule v2. Back-to-back same-room cases are split at the quietest point between them, so no activity between cases is orphaned and no case carries a long sparse tail. Add t_abs, meta.json and a gap schema. Make the cutter a daily command that reads a bookings CSV. Re-cut 8 Oct OT-2 as v2. Do NOT schedule it (no cron, no timer); the lead decides that after R6.

## Known facts
- Read O5-REPORT, O6-REPORT and ~/oc/orbox-refuter/R5-VERDICT.md first. R5 CONFIRMED v1.1 and raised the flags this order fixes.
- R5 tape layout: idx record k carries the cumulative byte_offset at the END of its chunk; its rms covers [bo(k-1), bo(k)); wall_ns is the chunk end. 16 kHz mono s16le, 32,000 B/s.
- R5 5-min density for 8 Oct: case 1 dense 09:05-11:05, sparse 11:10-12:15; zero at 11:35. Case 2 busy from 12:20 (0.9), quiet from 14:00. Case 3 dense 16:30-17:15 and 17:50-18:00.
- Bookings CSV (Mini ~/oc/orbox/metasurfer/ot-cases-2026-10-05_now.csv) columns used: case_uid, ot_room, sched_start_ist, sched_end_ist ("YYYY-MM-DD HH:MM", IST). Other columns carry procedure names: never copy them to orb2 or into the repo. Copy only a 4-column extract (case_uid, ot_room, sched_start_ist, sched_end_ist) to orb2 ~/orbox-lab/o7/bookings-<date>.csv.

## Rule v2 (one room, cases in booked order)
1. **Bins and runs.** Unchanged from v1.1: 30 s bins, active if more than 30% of records have rms > 0.01; runs bridge quiet gaps up to 10 min; drop runs under 3 min.
2. **Density.** d(block) = share of active 30 s bins in each 5-min block aligned to the wall clock (:00, :05, ...).
3. **Boundaries.** For each consecutive pair A, B: search S = [A.booked_end, B.booked_start]. If that is shorter than 30 min, use [B.booked_start - 30 min, A.booked_end + 30 min] clipped so it stays inside [A.booked_start, B.booked_end]. Find the minimum d in S. If several blocks tie, take the longest contiguous stretch of minimum blocks (earliest stretch on a further tie). Boundary = middle of that stretch, rounded down to 30 s.
4. **Segments.** Case i owns [boundary(i-1), boundary(i)]. The first case starts at booked_start - 120 min. The last case ends at min(booked_end + 180 min, tape end at cut).
5. **Onset.** Inside the segment, take the runs clipped to the segment. Onset = start of the first 5-min block with d >= 0.3 that lies inside a run. No such block: t0 = booked_start, t0_method booked_start, binding_method booked_slot. Otherwise t0 = onset, t0_method activity_onset, binding_method booked_slot+activity. (The v1.1 booked_start - 45 min clip is gone; the segment replaces it.)
6. **Offset.** Chain runs from the onset run with gaps of 20 min or less, inside the segment. Offset = end of the last 5-min block with d >= 0.3 in that chain. The booked_end + 90 min cap is gone; the segment replaces it.
7. **Window.** [onset - 15 min, offset + 15 min] clipped to the segment. Assert no overlap and fail loudly.
8. **Provisional.** As v1.1: true when window_end + 15 min is after the tape end at cut time, or when the last case's segment end is the tape end and its chain is still active in the last 20 min.
9. **Orphan check (report, not an assertion).** List every 5-min block with d >= 0.3 between the first segment start and the last segment end that is in no window, with its time and density.
Pass order in the code header: (1) density and runs, (2) boundaries, (3) per-case onset and offset, (4) windows and the overlap assertion, (5) orphan check.

## Package changes
- tracks/activity.jsonl: add `t_abs` (UTC ISO 8601 with ms, "2026-10-08T02:59:30.000Z") to every row, keep t_rel_ms.
- meta.json (PRD §6.4): {case_id, ot_room, room_uid (the Metabase ot__ot_room_uid if the CSV has it, else null), booked_start/end IST and UTC, team_roles: [], asa: null, times: {wheel_in: null, incision: null, closure: null, wheel_out: null}, simulated: false, source: "metasurfer bookings CSV <file name>"}. No names, no procedure.
- gaps: each entry {start_utc, end_utc, start_ist, end_ist, duration_s, byte_offset}. Empty list when none.
- runs_considered: each run gets start, end, clipped_start, clipped_end, length_min, in_chain. in_chain is true for every run that supplies the onset or the offset chain (fixes R5 flag 4).
- Manifest: rule_version "v2", boundary_prev and boundary_next (IST and UTC, with the minimum density used), segment start/end, orphan list for the room-day in a sibling file /var/lib/orbox-cases/days/<date>-<room>.json (not inside a case).

## Daily command
`cutter_v2.py cut --date YYYY-MM-DD --room OT-2 --bookings <csv> [--dry-run]`. Dry run prints the plan (boundaries, segments, onsets, offsets, windows, orphans) and writes nothing. Also `cutter_v2.py check --date ... --room ...` re-verifies sha256 and decode duration. Idempotent: if a v2 package with the same plan already exists, do nothing; if the plan changed, move the old one to _superseded_<rule>_<HHMM>/ (mv, no rm).

## Re-cut 8 Oct
- Fresh idx copy. Dry run first, put the plan in the report, then cut.
- In each case dir, mv manifest.json, media/, tracks/ into _superseded_v1_1/. Leave _superseded_v0/ where it is. Write v2 in place.
- Report a table: case, boundary prev/next (+ density), segment, onset/offset, window, t0 + method, provisional, duration s, flac sha12, then the orphan list.

## Code
- orb2 ~/orbox-lab/o7/cutter_v2.py, copy in ~/oc/orbox-builder/o7/. Stdlib plus /usr/bin/ffmpeg only.
- Commit it to ~/dev/eta-wt-orbox-lab, branch orbox/tooling-import, tools/orbox-lab/builder/o7/ (code only, no CSV, no plan output with times tied to case ids). gitleaks dir tools/orbox-lab must be 0. Push that branch only. Follow STANDING-COMMIT-RULE.md.

## Do NOT
- Run any python as root. `sudo -n cat` or `sudo -n dd` piped into python as vinay is the only read path. Write only to /var/lib/orbox-cases as vinay.
- Stop, restart or reconfigure room-recorder or room-bench. Write under /var/lib/room-recorder. Delete anything. Move audio off orb2. Transcribe. Message V. Install a schedule.

## Question to answer in the report
R5 flag 1: the sudo log shows `sudo python3 -` as root at 18:15:40 on 8 Oct from /home/vinay. Say exactly what that ran and why.

## Output
~/oc/orbox-builder/O7-REPORT.md, cap 50 lines: the 18:15 answer, dry-run plan, per-case table, orphan list, script sha256, commit sha and push line, gitleaks line, flags. Pane reply 5 lines max. You report to orbox-lead.

## Ruling (lead, 23:05 IST): rule v2.1, re-cut, then commit without push
1. **Onset (fixes flag 1).** Onset = start of the first run of 3 or more consecutive 5-min blocks with d >= 0.3, inside a run, inside the segment. Offset is unchanged from v2.
2. **Bin attribution (flag 7).** Put each idx record in the 30 s bin of its chunk START (wall_ns minus samples/16000 s), per R5.
3. **No qualifying onset (flag 6).** Accepted: window = booked slot +-15 min clipped to the segment, t0 booked_start, binding_method booked_slot. Write this in the code header.
4. **Ties (flag 2).** Accepted as written: longest stretch, then earliest.
5. **Session id (flag 4).** Accepted. Add recorder_session_id_source: "status.json" or "previous manifest".
6. **room_uid (flag 5).** Accepted. Keep ot__ot_room_uid in the extract whenever the bookings CSV has that column.
7. rule_version "v2.1". Dry run, then re-cut 8 Oct. Current v2 goes to _superseded_v2_<HHMM>/ by your idempotent path (mv, no rm). Report the new table and orphans in O7-REPORT.md (add a "v2.1" section, keep the v2 section).
8. **Git.** Commit only, no push: in ~/dev/eta-wt-orbox-lab stage by exact filename tools/orbox-lab/builder/o7/cutter_v2.py, tools/orbox-lab/orders/ORDERS-O7.md, tools/orbox-lab/orders/O7-REPORT.md. gitleaks dir tools/orbox-lab 0 first. orbox-lead pushes after R6. If the commit is also denied, stop and say so. Do not retry or work around it.
9. R5 flag 1 is closed. The 18:15 root read was the outgoing lead's, not yours. It changed nothing (R5 P5). No root python from anyone from now on.
