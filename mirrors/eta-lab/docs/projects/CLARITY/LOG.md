# LOG — CLARITY (readable, accurate consult transcripts)

Build and event log, newest first. Owner panes: lab-viewer, linker, split-speaker, diar-lab. Plain words; counts and ids only.

## 27 Sep ~07:2x-09:5x IST — router root cause + fix built; automated scorecard ruled
Session: lid-debug, router-fix, diar-lab, linker, lab-viewer, cap.
lid-debug found the router has no acoustic LID (6 mechanisms M1-M6, router_server.py 400710ee; ~35% of en-tagged real windows are Indic, #4108). router-fix built router-fix/lid removing M1-M5, pre-registered its offline eval (#4127/#4128), eta-refuter-2 code-PASS (#4130), eval running now. V ruled (W33, 08:05): no human listening today, three automatic scores (S1/S2/S3), win rule = S2 improves + S1/S3 not worse. diar-lab built S1 suite clinical1 (PASS ef19d6a2) and two S3-judge confirmation suites confirm2 (PASS ec965b16) + confirm3/confirm3diag (PASS cc9b2822/7397c881) after two judge wordings failed the usability gate. lab-viewer shipped /clarity (LIVE 162ff4b8/fa5e58bb) with a SCORECARD panel, catching a real bug (S3 trusted the judge's own usable flag) before PASS.
Refs: #4108, #4127, #4192, #4211, #4269, #4277, #4179.

## 26 Sep ~21:0x IST — stt-bench blocked on label200 access
Session: stt-bench.
label200 gloss + provenance files return EACCES from the pane (#3899). Needs read access or a copy from Fable/V.
Refs: #3899.

## 26 Sep ~16:45 IST — 427L label200 repair LIVE
Session: Fable (orchestrator). eta-refuter-2 checked.
V's rating page was broken (audio dead on save, "Next unlabelled" skipping, language "undetermined"). Fix PASSed by eta-refuter-2 at d5e82fe (byte-identity: only test + tool files changed; worker/ identical; NEW 35/35 vs OLD 5/35 with V's exact symptom). Merged main 1e1a8518, deployed v6713bbe8. R5 after-deploy confirmed: 16 rows sha 93fdea08, doc byte-unchanged, lang-map readback 587daa67. V can rate.
Refs: #3645, #3667, FABLE 450; r427L.

## 26 Sep ~05:30 IST — calib30 FAILED → V rates all 200
Session: eta-refuter (scorer).
Calib30 machine labels agreed only 63.4% with V (threshold 86.7%). r421a: machine labels rejected; V rates all 200 label200 rows himself.
Refs: #3205, r421, r421a.

## 25 Sep — 337 pipeline built
Session: lab-viewer (viewer), linker (translation), split-speaker (metrics), diar-lab (speakers).
Declared top programme (r337). 337a Consult View; 337b Gemini 3.8 Flash translated 2,611 windows; 337c 5,130 segments re-transcribed forced-language; 337d guard drops 0/30 real windows; 337e speaker labels across 4,167 vault windows.
Refs: r337, r337a-f, r418.

## Back-fill note
15–19 Sep: this programme's roots (transcript hygiene, STT stack) predate this log's detail. Earliest clean milestone here is r337 on 25 Sep. Earlier days can be reconstructed from orders/STATE-OF-PLAY-24-SEP.md if needed.
