# LOG — PRESCRIBE (CAP-1 audit + CAP-2 vocabularies)

Build and event log, newest first. Owner panes: linker (bundle), cap (c3 evaluator), eta-refuter-2 (checker).

## 26 Sep ~16:00 IST — bundle v3 built; naming PASS opens scoring
Session: linker (OpenCode, glm-5.3-flash); eta-refuter-2 (checker).
Bundle v3 supersedes v2: 24 linked / 15 confirmed, English COMPLETE 189/189, honest smaller n (fewer links than v2). CAP-1 naming PASS: cap_link 2b96fdfd + cap_bundle 99023b74 + ceiling f363a3e; MANIFEST 7/7 sha-verified on disk; #3506 re-check PASS (both refusal paths exercised, pins MATCH, selftest 0). cap may score v2 now; v3 re-check sits before v3 scoring.
Refs: #3655/#3658, #3662.

## 26 Sep ~17:30 IST — v3 re-check PASS; cap may score v3
Session: eta-refuter-2 (checker).
CAP-1 v3 re-check PASS: MANIFEST v3 7/7 on disk = linker's shas; reproduction 183/183 link records EXACT on 16 fields; thresholds lo/hi EXACT; held-out wrong-time control (shifts ±45/60/120/180/240) false-link 1.8-7.4% / false-confirmed 0.6-3.3% (v2 was 3.1-6.1% / 1.0-3.6%, same envelope). +120 shift any-link 7.4% sits above the 5% target (confirmed ≤3.3%) — report must carry the held-out numbers. Still owed before V runs `run`: draw.json-vs-commit + salt reveal.
Refs: #3687.

## 26 Sep ~10:46 IST — bundle v1 FAILED
Session: eta-refuter-2 (checker).
v1 bundle: wrong-time control showed 33.8% false links vs 45.7% true (~64/86 chance); 6 consults duplicated; 36 items leaked complaint terms.
Refs: #3491.

## 26 Sep ~09:30 IST — authorised
Session: Fable (orchestrator).
CAP workstream authorised (r429/430); pane `cap` launched on eta-ci-c3 w1:p1 on a paid model (r430b).
Refs: r429, r430, r430b.

## Standing leak rule
A prescription or note never feeds the transcript of the same encounter or day. CAP-2 (vocabularies to steer STT/translation) is the second half, not yet started.
