# EB-0A cloud build report (role_votes.v1)

Serving model: claude-sonnet-5-5 (Sonnet 5.5).
Branch: cloudpane/cloud-eb-0a-build/build
Code commit: e5245077 (report and outbox land in the next commit on the same branch)
Files: tools/encounter_brief/role_votes.py, tools/encounter_brief/tests/test_role_votes.py
Tests: 37 passed, 0 failed (`python3 -m pytest tools/encounter_brief/tests -q`; needs numpy, pytest). Synthetic only.
Not run: the 60 real consults, anything on the box.

## Monday commands (run from the repo root, plain script, no package install)
Flags shared by build and fa-check:
  --vecs vecs.json  --centroids centroids.json  --doctor-uids uids.json  --clef-votes clef.jsonl  --jev-votes jev.jsonl
  --clef-doctor-slot slots.json  --role-segments roles.jsonl  [--jev-set-id ID]  [--created-at 2026-10-17T00:00:00Z]
  python3 tools/encounter_brief/role_votes.py build <shared flags> --out-dir OUT [--layout layout.json]
  python3 tools/encounter_brief/role_votes.py reproduce --in-dir OUT
  python3 tools/encounter_brief/role_votes.py fa-check <shared flags>      (exit 0 only if the count is 0)

## Input formats
- uids.json {consult_id: doctor_uid|null}; slots.json {consult_id: "speaker_N"|null}; absent key = Clef has no data (mapping failed).
- clef/jev jsonl: consult_id,t0_ms,t1_ms,slot,voter,p_doctor,p_patient,p_attender,p_staff (one row per Nemotron segment, as merge_c wrote them).
- roles.jsonl: consult_id,t0_ms,t1_ms,role (or json {consult_id:[rows]}).
- layout.json {consult_id: relative dir}; default OUT/<consult_id>/role_votes.v1.json.

## Output
Per consult: spec 5.6 layer plus three_of_three, armc_old_label, armc_new_label, voiceprint_match_label, order_capable,
order_capable_armc_old, case (1-7|null), case_flags, degraded, per-label cos and both margins, metadata. Mode 0600, dirs 0700.
reproduce prints counts of consults with zero order-capable segments: 3/3 alone, armc_old (3/3 or T), armc_new (full ruling 6).

## Assumptions (mine, not in the brief)
1. The Nemotron label timeline is the union of segments in the clef and jev jsonl. No separate Nemotron input exists.
2. Role-track segments carry no label. Each goes to the label with the largest overlap. Zero overlap or a tie = unplaceable = mapping ambiguous. A role segment sitting in silence will therefore mark a real consult ambiguous; if Monday shows too many, that threshold is the knob.
3. Mapping failed = role track, Jev rows or the Clef doctor_slot key is missing for the consult. Clef slot null is "undecided", not failed.
4. Voter 1 doctor = role majority by overlapped ms is "doctor". Jev doctor = p_doctor >= 0.6. Jev doctor_rank = rank by p_doctor.
5. D2 "non-doctor with p >= 0.6": max(p_patient,p_attender,p_staff) >= 0.6 for Clef and Jev; for the role layer, majority role in {patient,attender,staff,other} holding >= 60% of placed speech.
6. armc_new thresholds use 1e-9 slack so exact 0.65 and 0.05 pass; armc_old is raw floats like merge_c. Alone label: next-label margin passes. One-centroid set: runner-up margin missing, so abstain.
7. Mapping not clean: armc_new, voiceprint_match_label and order_capable are off; armc_old and cosines are still computed. armc_old needs no mapping.
8. Two 3/3 labels cannot occur from the CLI (Clef names one slot). The rule is implemented and tested in resolve_order directly. With two 3/3 labels and no voiceprint, nothing is order-capable.
9. created_at defaults to SOURCE_DATE_EPOCH, else now. Pass --created-at for byte-stable reruns.
10. Jev question id and model are null in metadata (no flag supplied); only --jev-set-id is carried.

## Notes for the lead
- fa-check counts a 3/3 label with no voiceprint match as order-capable (case 6, by ruling 6). On P-SYN, a synthetic 3/3 label would count as a false accept. My fixture uses a null Clef slot.
- Exit check 1 (37/60 and 15/60) is not reproduced here; reproduce prints the three counts for it.
