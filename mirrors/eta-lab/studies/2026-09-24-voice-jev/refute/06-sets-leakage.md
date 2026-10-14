# Refute: vj-data sets.json, doctor-profile leakage (M2), checked 17:3x IST (box clock)
- M2 PASS. I rebuilt the test room-days independently from Neon (room_turn_speaker.room_day_id over the 76 test windows, 74 of which have turn rows): 31 room-days.
  - vj-data lists 34. That is a superset: 0 of mine are missing from theirs, so they are conservative.
  - The 4 profile room-days overlap neither list.
- Coverage: 3 clinicians are attributed in the test windows, and all 3 have profile windows. Profiles span 3 rooms.
- Page-source windows (V5 + SC30): 22 windows over 11 rooms, so the ">= 8 doctors or rooms" spread is feasible by room.
  - Turns in rooms with no profiled doctor will have a missing margin and so be DOUBTFUL (section C). The confident pool will come mostly from the 3 profiled doctors' rooms.
- Blinding: data/*.py never opens key.json, human-counts or truth. The only mentions are comments.

## Who-is-speaking page (tools/who-is-speaking, surg-page; shell with mock turns, reviewed on origin 1ae841f)
- PASS on design. The seed contract allows only id, audio, duration_s, turn_start_s, turn_end_s and text. check_seed.py rejects any other field: no production role, margin, doubtful flag, doctor, room or window id. Ids are opaque, the order is a fixed hash, and the page shows only "Turn n of 150".
- Minor: `labels` is readable by any interacting user, so one rater could see the other's answers through devtools (the README admits this). Low risk with two trusted raters, but their answers are then not provably independent.
- To check when vj-data seeds the page:
  - run check_seed.py myself on the real seed, expecting 150;
  - confirm the key file (id -> turn) stays in ~/vj/ and off the page;
  - spot-check 5 clips for the turn marker position and the 0.8 s minimum.
