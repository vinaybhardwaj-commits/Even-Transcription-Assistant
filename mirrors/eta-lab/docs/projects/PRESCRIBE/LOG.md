# LOG — PRESCRIBE (CAP-1 audit + CAP-2 vocabularies)

Build and event log, newest first. Owner panes: linker (bundle), cap (c3 evaluator), eta-refuter-2 (checker).

## 26 Sep ~21:2x IST — Pulse Rx extract built
Session: linker, eta-refuter-2, cap.
Script 08cd6a18 PASS (#3908); run: rx_history.jsonl 200,098 lines, sha256 cd012fae, 26 Jun-24 Sep, 0 rows on 25/26 Sep, 121 doctors, 30 specialties (#3914); independently verified (#3915). cap will pull via the read-only jail after Fable's permission OK, and post the pre-registration sha before any hinted run (#3926/#3927).
Refs: #3908, #3914, #3915, #3927.

## 26 Sep ~18:1x-20:1x IST — CAP-1 FINAL (957f93c4); CAP-2 opened
Session: cap, linker, eta-refuter-2, roadmap.
Ceiling chain: linker committed C before the draw (#3789); cap's first ABSENT-id list was a from-memory copy and the sha check rejected it (#3803/#3806/#3810), correct list placed and sha-verified (#3813/#3819/#3821); draw done (#3823), refuter-2 draw gate PASS (#3825/#3843). Ceiling score PASS (#3849): target 6/60 = 10.0%, decoys 1/60 = 1.7%, McNemar p=0.125. cap's final report 957f93c4 (#3855). W27.1/W27.2: CAP-2 vocabularies opened; linker extracts Pulse Rx history since 26 Jun (excl. 25+26 Sep); vocab 28 Sep, before/after 29 Sep (#3880/#3886).
Refs: #3843, #3849, #3855, #3880.

## 26 Sep ~17:4x IST — CAP-1 SCORE COMPLETE (scorer efcc9c9)
Session: cap (evaluator).
v3 scored 17:20-17:40 IST after gates: scorer+runner efcc9c9 (sha 77ea0eee), 38/38 fixture tests, thresholds frozen pre-data (TAU_CAPTURED 0.88 / TAU_MISHEARD 0.72), two reruns byte-identical, MANIFEST 7/7 re-verified. 169 SCORED items (24 linked consults): CAPTURED 50 (29.6%), LOST-IN-TRANSLATION 0, MISHEARD 5, ABSENT 94 (55.6%), ABSENT-SPEECH-GAP 20. By class: drug 9.4% (3/32) — the weak class; dose 38.7%, diagnosis 26.3%, investigation 30.3%, advice 34.8%, followup 36.0%. Report carries refuter-2's held-out envelope verbatim (+120 any-link 7.4% above the 5% target; confirmed ≤3.3%; in-sample not used). Ceiling chain: ABSENT sha d5dbd361 → linker commit → draw 15 confirmed → refuter-2 gate → V. Report file by 20:00 IST.
Refs: #3783, #3784, #3785, #3786.

## 26 Sep ~18:0x IST — cap ONLINE on c3; scorer build started
Session: cap (evaluator).
cap ONLINE on eta-ci-c3 (pane w1:p4): ~/eta-data-ro lists read-only (no writes attempted); resource rules acknowledged (heavy work nice 10, ≤8 threads, hands off ~/histwork, ports 8082-8089, /tmp/eta-ci-c3-ci.lock). Bundle v3 MANIFEST verification + scorer build started → 20:00 report path live. Mirror question settled (own #3757, 4 sealed blobs, 19:30).
Refs: #3766.

## 26 Sep ~17:2x IST — 459.5 report inputs delivered; cap scoring v3
Session: linker (inputs), eta-refuter-2 (independent verify), conductor (relay), cap (scoring).
Report-input numbers verified on disk 17:19 (bundle v3 MANIFEST 7/7): 183 tokens; 24 linked = 15 confirmed (TC 9/TCD 4/TCDM 2) + 9 probable (TC 5/TCD 1/TCDM 3); English 189/189 (0 missing); in-sample control 667 null trials (false-link 4.35%, false-confirmed 0.9%); held-out ±45/60/120/180/240 min (refuter-2 #3687) false-link 1.8-7.4% / false-confirmed 0.6-3.3% — the +120 any-link 7.4% sits ABOVE the 5% target and must be called out in the report. Delivered to cap via the disclosed herdr-prompt path (bus unknown_agent persists); cap scoring v3 now. Ceiling chain: cap ABSENT sha → linker commit → draw 15 confirmed → refuter-2 salt/draw gate → V runs `run`. Report due 20:00 Fable-clock.
Refs: #3754, #3755, #3758, #3759, #3761.

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
