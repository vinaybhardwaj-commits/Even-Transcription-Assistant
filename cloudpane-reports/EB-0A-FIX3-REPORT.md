# EB-0A fix round 3 report

Serving model: claude-sonnet-5-5 (Sonnet 5.5). Branch: cloudpane/cloud-eb-0a-build/fix3 (from fix2 106c19d4). Tests: 108 passed, 0 failed (93 before). The 9 new H1/H3 tests fail on the fix2 code and pass here. Synthetic only.

## One line per item
- H1 DONE. N1 no longer needs the next-label margin. A label is an N1 candidate when cos >= 0.65 and its runner-up-centroid margin >= 0.05. Any candidate other than the 3/3 label gives order_capable [] and case 5, whether or not the 3/3 label has a vector. Your case (two other labels at cos 0.9) is tested, with and without a vector on the 3/3 label. Candidates are written as n1_candidates. voiceprint_match_label and arm (c) keep the full rule, so the margin-tie case shows no match but still blocks. With no 3/3 label and a candidate, the case is 2.
- H2 DONE. psyn_truth.py is rewritten against the real script.json schema (eval/pdqi9/psyn, eb08e73): speakers[role, is_treating, intended_diar_label], turns[speaker_id, est_seconds, overlap_with]. treating_doctor is in the doctor words. Only the is_treating speaker is "doctor", and it needs exactly one per script with role treating_doctor, else exit 2. Each Nemotron label takes the role holding the majority of its overlapped ms; under 60%, or no overlap, it is "mixed". "mixed" is a new truth role. Tested on 4 verbatim generator scripts from a default-seed run (252 scripts built), committed under tests/fixtures/psyn with a provenance README.
- H3 DONE. A duplicate (consult, label) row in the truth file exits 2 in fa-check and reproduce, one stderr line. An order-capable "mixed" label counts in order_capable_not_doctor (by route), never in yield, and is also counted in order_capable_mixed.

## Monday command for the projector
  python3 tools/encounter_brief/psyn_truth.py --scripts-dir <generator dev/ or test/ dir> --nemotron nem.jsonl (--turn-times turns.jsonl | --est-timeline) --out truth.jsonl
  nem.jsonl rows: consult_id (= script_id), label, t0_ms, t1_ms.  turns.jsonl rows: consult_id, turn_id, t0_ms, t1_ms.

## Assumptions
1. The generator is text only, so turn times must come from the synthesised audio (--turn-times). --est-timeline is a rough stand-in (turns back to back by est_seconds; an overlap_with turn starts with the turn it overlaps) and is explicit, never the default. Exactly one of the two is required.
2. Nemotron consult_id equals the script_id.
3. Roles pool by role, not by speaker: three attenders on one label are one role.
4. A Nemotron consult with no script, or with no turn times, is an error (exit 2). A script with no Nemotron rows is skipped.
5. Unknown role words (outside the schema's six) map to other_clinician if doctor-like, else other, never doctor.

## Residual risks
- Majority projection can label a shared Nemotron label "doctor" while another voice also speaks on it. In the real fixtures, PSYN-SM-002 (doctor + patient on one label) and PSYN-SM-014 (doctor + other_clinician on one label) both project to "doctor". An order-capable label of that kind counts as yield, though part of its audio is not the treating doctor. The S-M numbers should be read with that in mind.
- A vectorless real-doctor label is still invisible to N1 (unchanged from fix2).
- H1 blocks more consults whenever two non-doctor voices resemble the logged-in doctor; expect yield to fall on voice-alike strata.
- Not run on real data or on real Nemotron output for P-SYN audio.
