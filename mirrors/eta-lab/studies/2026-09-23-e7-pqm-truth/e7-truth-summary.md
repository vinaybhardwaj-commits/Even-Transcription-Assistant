# E-7 truth table summary (2026-09-23)

Room->doctor map = voiceprint-attribution.json only (display-board config not in the warehouse: `even_hospitals.doctor_opd_rooms` is NULL on all 3 hospital rows).
9 of 33 sessioned room-days are voiceprint-confirmed (>=30 attributed turns, one clinician >=80% of them): Cardiology OPD (21/22/23 Sep, the Cardiology OPD clinician), OPD 3 (21/22/23 Sep, the OPD 3 clinician), OPD 5 (21 and 23 Sep, the OPD 5/6 clinician), OPD 6 (22 Sep only, the OPD 5/6 clinician).
24 room-days are unmapped (no attribution or below threshold): all of OPD 1, OPD 4, OPD 6 (3 of 4 days), OPD 7, Dietary Room, Third Floor Consultation, ORB3 (all 3 days — excluded despite nonzero attribution, only 10-25 turns, same doctor as OPD 3, treated as unconfirmed), plus OPD 3 on 20 Sep and OPD 5 on 22 Sep (no session/no attribution that day).
`e7-truth.csv`: 55 PQM consult intervals across the 9 confirmed room-days, scoped to each doctor's own calls on that IST date (called_at date, not cycle_bucket, per the standing ruling), both `called_at`/`completed_at` present, duration 1-60 min.
Excluded from those 9 room-days' raw 59 same-day consults: 1 missing a time, 3 outside the 1-60 min window (55 kept of 59).
Per confirmed room-day: Cardiology 21 Sep 3/5 kept, 22 Sep 7/7, 23 Sep 3/3; OPD 3 21 Sep 6/6, 22 Sep 13/15, 23 Sep 8/8; OPD 5 21 Sep 4/4, 23 Sep 3/3; OPD 6 22 Sep 8/8.
No scoring against E-shadow/E-6 hypotheses done here — per instruction that comes after E-6.
No patient identifiers or transcript text in any output file; `token_uid`/`doctor_uid` are opaque PQM ids, not names. Doctor names redacted to room-based labels before this file was committed to eta-lab — see `findings.md` for the raw-file location.
Built locally on the Mini (python3, stdlib csv only, 669-row input, not run on e2e-lab — a CSV join this size is well under any "heavy" threshold). Output files: `e7-truth.csv` (55 rows), `build_truth.py` (the join script, for audit), this summary.
Caveat: ORB3's exclusion and the OPD 5/OPD 6 partial-day pattern are judgment calls on a threshold the order didn't fix numerically (>=30 attributed turns, >=80% one clinician) — flagging rather than deciding silently.
