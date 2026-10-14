# STT-STACK-PARITY order 1 — bar pre-registered BEFORE the scored run (lab-mover, 24 Sep ~13:05 IST)

Disclosure first: an earlier smoke run on the box produced no result, and the first window of the real run had scored
(char similarity 0.857, kn->kn) before I wrote this. That window is in the set; no threshold below was tuned to it.
The run was restarted after eta-refuter-2's #226 so the harness also saves raw twin outputs, hashes the input audio and measures loops.

## What is compared
Twin = router + eta-indic + SraVaani + whisper shim/server on a gcp-l4 clone (hist-gpu-1/2, no Mini/Yoga call), request shape = production room path
(POST /route/job, translate=false, candidates en,kn,hi,ta,te,ml,mr,bn, window_s=180).
Stored = transcription_run rows engine='route' created after the router's last restart (23 Sep 13:18:18 IST) and before 24 Sep 03:00 IST.
Input = the stored clip object (metrics_json.clip_r2_key) from R2; its sha256 must equal the row's audio_sha256 (else the window is excluded, and counted).
Windows: 18 fixed by md5(id) order inside strata: G1 guard fired app-side (assembled_collapse.changed), G2 empty transcript/silence, G3 English, G4 Indic (kn/ta/hi/te/ml/bn). Ids in git, text never.

## Bar (all numbers are per window unless said)
- B1 text: median normalized-Levenshtein similarity of normalized transcript_original >= 0.80, and no non-silent window < 0.50.
- B2 language: dominant-language tag equal (first 2 letters) in >= 90% of windows.
- B3 routing: time-weighted share of stored engine spans whose overlapping twin segment used the same engine and language: median >= 0.80.
- B4 silence: every stored-empty window (G2) is also empty on the twin, and the twin reports the same route_outcome/status.
- B5 loops: unique word-3-gram ratio of twin vs stored: median absolute difference <= 0.05, and at most 1 window where twin ratio < stored ratio - 0.15.
- B6 wiring: router env has only 127.0.0.1 backends; no connection to the Mini/Yoga addresses during the run (ss sample + config).
Verdict rule: PASS only if B1-B6 all hold. A miss is reported with the numbers, not re-tuned.

## Noise floor (why B1 is not 0.95)
The archive has NO window that production ran twice since the cutoff (0 of 392 rows share a clip), so a production-vs-production floor cannot be measured.
Substitutes, reported separately and never mixed into the bar: (a) twin-vs-twin repeat runs of 4 windows (whisper temperature fallback is
non-deterministic, IndicConformer/SraVaani CPU are not expected to vary); (b) the whisper twin parity numbers already in PARITY-WHISPER*.md.
If twin-vs-twin median similarity is itself < 0.90, results are labelled noise-limited and the verdict is "PASS/FAIL within noise", not a clean PASS.

## Not covered here (named, so nobody assumes it)
- Fused/translated result (Gemini flash fuse): room windows use translate=false, so the fuse model is not on this path; the encounter/translate path is not scored in this run.
- Numeric drift: Mini = Apple silicon (Metal whisper), twins = CUDA whisper + x86 CPU IndicConformer/SraVaani; per-window drift is expected and is what B1-B3 allow for.
- ffmpeg build differs (Mini Homebrew 8.x vs static 7.0.2 on the nodes).

## ADDENDUM 1 (14:00 IST, written BEFORE the second set is scored) — a confound found after set 1 was scored
Set 1 (18 windows, created 23 Sep 13:30 -> 24 Sep 03:00 IST) was scored against the bar above: B2 language 13/18 = 72% (bar 90%), B1 median similarity
0.792 (bar 0.80, one window 0.491 < 0.50), B3 0.851 PASS, B4 4/4 PASS, B5 median 0.014 PASS. By the pre-registered rule that is a FAIL (B1, B2). It stays reported as such.
Cause candidate found afterwards: the Mini whisper-server ran WITH `--vad --vad-model <silero>` until 24 Sep 04:39:10 IST (minibot, ledger line "who turned the VAD gate off"), and
the twins run the CURRENT production flags (no --vad, ruling 24). Set 1 was therefore produced by a different whisper configuration than the twins run. The twin also refuses many
segments in English windows via english_hallucination_guard (15-22 per window in several windows, where the stored text kept whisper output), which is the pattern expected if
non-speech that --vad used to gate now reaches whisper. This is a hypothesis about set 1, not a finding.
Set 2 = like-for-like: same strata and same md5 ordering, but only production runs created on/after 24 Sep 05:00 IST (after the 04:39 restart, so whisper had no --vad), disjoint from set 1.
SAME bar B1-B6, unchanged; the verdict for the current production stack is set 2's. If set 2 also fails, the hypothesis is wrong and set 1's failure stands as a twin defect.
Optional set 1b (only if time): twin whisper WITH the old VAD flags on set 1's windows, to test the hypothesis directly.
