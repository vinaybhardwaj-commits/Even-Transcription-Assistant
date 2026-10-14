# Refute: vj-data embed.py (margin recompute, step 1a), pre-result review

OK:
- Model is pyannote/wespeaker-voxceleb-resnet34-LM, offline cache at snapshot 837717ddb9ff. This is the same revision as the refuter env (M1 PASS).
- Profiles come from PROFILE windows only (M2 verified in 06). Turns counted: role clinician, or a majority-clinician speaker group (= speaker_basis != diarization_only). Turns >= 0.8 s, crops <= 20 s, <= 300 turns per doctor, seed 24092026. Profile = mean of unit vectors. This matches ruling 165 C (M3 PASS by reading).
- SC30 clusters use the excerpt audio only, with turn times shifted by provenance start_s. Neither key.json nor the hidden fields are read.

Interpretation vj-data chose (this answers my R165-1):
- The margin is per production CLUSTER (window, speaker_idx), not per turn. One embedding per cluster, from its >= 0.8 s turns, longest first, up to 60 s. Every turn in a cluster will then share that cluster's margin.
- Runner-up = the best OTHER cluster in the window, i.e. reading (ii). That is consistent with "the best other speaker cluster in the same window" in section C.
- Consequence: turns < 0.8 s and turns with speaker_idx NULL get no cluster embedding, so their margin is missing and they are DOUBTFUL.

Watch items for the margin step (not written yet):
- W1: the candidate doctors for a window must be that ROOM's doctor(s). Section C says "no profile for that doctor -> margin missing -> DOUBTFUL". If the margin step instead scores every cluster against all 3 profiles, rooms whose doctor has no profile would get a real margin against another room's doctor. Those turns would become falsely CONFIDENT.
- W2: cluster embeddings use up to 60 s of concatenated speech, but profile turns are single turns cropped to <= 20 s. Cosine scales differ between long and short inputs, which may shift the whole margin distribution against the fixed 0.10 cut.
  - The frozen 0.10 was set for production's scores.
  - I will report the margin distribution next to the doubtful count.

## selector.py + test_selector.py (K1 step 2): PASS with 2 minor notes
- W1 is resolved by design: margin() takes cos_by_cluster against the ROOM doctor's profile only (docstring). To confirm on the data when the margin runs: a room whose doctor has no profile gets margin None.
- Margin = own-on-top: top - second; own-not-top: top - own. That is the distance from the doctor/not boundary, so a clearly-not-doctor cluster is correctly CONFIDENT.
- Tests: 5 hand-checked turns. Arithmetic re-done by me (0.71-0.52 = 0.19; 0.71-0.20 = 0.51); the strict < 0.10 edge and the missing-margin and missing-count rules are all correct. python3 test_selector.py passes.
- N1 (float edge): margin("0", {"0": 0.62, "1": 0.52}) = 0.09999999999999998, which is classified DOUBTFUL although the true gap is exactly 0.10. Round the margin to 6 decimals before comparing. Impact is tiny, but it is a real boundary bug.
- N2 (no absolute floor): a top cluster with low cosine (e.g. 0.30, doctor absent or locum) still gets a real margin against the second cluster. The frozen definition has no floor, so this is not a violation, but I will report how many CONFIDENT turns have top cosine < 0.4.
## descriptors.py (K1 step 3): note
- The "usual" profile uses every doctor-attributed turn >= 0.8 s from PROFILE windows. The order says the doctor's CONFIDENT turns only. Attributed (not diarization_only) is close but not identical: margin and count disagreement are not applied. Test windows are excluded as required. Minor: flag it, do not block.

## classify.py (K1 step 2b), pre-run review
- Room doctor = the single profile clinician for that room, from profile windows only. Checked on the test turns: every production 'clinician' turn in a test window (137 + 865 + 40 in the 3 profiled rooms) names exactly room_doc, with 0 mismatches. W1 is honoured: a room with no profile gets margin None and so DOUBTFUL.
- Only 18 of 76 test windows sit in a room with a room doctor (3 rooms), so CONFIDENT turns can only come from those 3 rooms. The 40 confident page items will be 3 doctors' voices; the ">= 8 doctors or rooms" spread must come from the doubtful items.
- C1 (upgrade of N1, concrete): classify() is called with the UNROUNDED margin, but classification.json stores round(m, 4). vj-arms arm1.py recomputes doubtful from the STORED margin and refuses to run on any mismatch. A margin in [0.09995, 0.1) is stored as 0.1000 but classified doubtful, which causes an arm1 refusal (or, if the flag is dropped, a silent flip).
  - Fix: m = round(m, 4) before classify().
