# even-orbox-lab

Code and records of the ETA ORBOX thread (orbox-lead), which runs the OT recorders:

- **ORB2** (vinay-orb2): records OT2.
- **ORB3** (orbox3): the lab box.

No audio, tape, transcripts or patient data are kept in this repo. Those stay on the ORBoxes, on the clinical rail. The repo holds only scripts and the written orders, reports and verdicts.

## Layout
- **orders/** holds the written records:
  - lead orders: ORDERS-O*, ORDERS-R* and ORDERS-W*;
  - builder reports: O*-REPORT;
  - refuter verdicts: R*-VERDICT;
  - the ORBox design, kit and handover notes.
- **builder/o1..o5** holds the builder scripts:
  - o1 and o2: tests of noise removal and of picking the better mic.
  - o3 and o4: the deterministic lab scorer. scorer4 is lab scorer v4: faster-whisper with temperature=0.0 and no_repeat_ngram_size=3.
  - o5: the ORB2 case cutter. cutter_v1.py is rule v1.1.
- **refuter/**, **orb3-remote/r3,r4** and **orb2-cutter/r5** hold the refuter's independent scripts.
- **orb2-cutter/** holds the cutter and the R5 checker as deployed on ORB2 (~/orbox-lab/o5 and ~/orbox-lab/r5).
- **orb3-lab/** holds the ORB3 lab scripts from /var/lib/orb3-lab: runs 1-4, the room map and the OT scans.
- **metasurfer/** holds the repeatable warehouse SQL for EHRC OT bookings.

## Status (8 Oct 2026)
- Lab scorer v4 is adopted.
- The three OT-2 cases from 8 Oct have been cut into case packages on ORB2 (/var/lib/orbox-cases), and the refuter confirmed them (R5).
- The full story is in the Claude project docs claude/ETA-ORBOX-THREAD-BRIEF-07-OCT-2026.md and claude/ORB3-LAB-O1-R1-07-OCT-2026.md.

## Identifiers (scrubbed 8 Oct 2026)
Hospital case ids, room and session ids are replaced here with placeholders (case-1/2/3, <scribe_room_id>, <recorder_session_id>, :hospital_uid, :ot_room_uid). The archived o5 and r5 scripts kept their case lists in code, so here they carry the placeholders and do not reproduce the 8 Oct run. cutter_v2.py reads case ids only from a local bookings CSV (see bookings.example.csv, real extracts are gitignored) and the room id from ORBOX_ROOM_OT2.
