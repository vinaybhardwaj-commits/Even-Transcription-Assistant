# Router language fix (W30.1 M1+M2): proposal + pre-registration (lid-debug, 2026-09-30; Fable #7733 item 2; root cause #7707)
Status: r8 = r6 (PASSED eta-refuter-2 #7900) + A1 + A1.5 (06 Oct; A1 pending eta-refuter-2). Earlier history: PASSED by eta-refuter-2 #7757/#7761 (r1 3f28288a; r2 0c688767 #7753 B1-B3; r3 adds the #7757 E4 no-read rule + V preferred). Nothing built or run for this document. Production untouched.

## 0. The one thing to know first
The M1+M2 fix has ALREADY been built and scored once (W31, router-fix/lid a06643c..b9085b1, 27 Sep). It fixes the language label and it
LOWERS clinical capture. S1 clinical1, run 27 Sep 04:21-05:57 UTC = after b9085b1 (M1-M5) and before any M6/ETR commit
(eval-out/dev-capscorer-dose.txt; refuter-2 #7134 confirmed the NUMBERS; that "NEW" = the M1-M5 build b9085b1 rests on
MY timestamp check: S1 run 09:51-11:27 IST, b9085b1 07:21, first M6 commit 90169aa 11:54, new-selftest.jsonl 07:57):
  S1 drug+dose  ALL P 81.0 -> NEW 73.0 | hi-en 85.7 -> 65.1 | ml 76.2 -> 50.8 | te 81.0 -> 71.4 | ta 66.7 -> 63.5 | hi 79.4 -> 77.0 | en =
  cap captured  ALL P 45.3 -> NEW 23.4
Mechanism: on hi-en, 20/24 windows moved from Whisper (Latin drug names + digits) to SraVaani (Devanagari transliteration). The "wrong"
English path was carrying the clinical tokens. So this proposal gates on BOTH language recovery and clinical not-worse, and pre-registers
a second arm that keeps Whisper's clinical spans when the Indic side wins.

## 1. Arms
 P    production router_server.py sha256 400710eeb45c (box twin, port 8083), unchanged.
 R-A  the M1+M2 fix and the pieces it exposes, all already on router-fix/lid, ETR excluded:
      a06643c M1 Whisper verbose_json (real w_lang and p(en));  baf5e2a M2 p(en) < 0.9 opens the Indic path (no 1.8x length rule);
      2f7bf85 M3 no first-head short-circuit;  9cfd20c M4 no temperature fallback on the judging call;  b9085b1 M5 emit the judged text;
      90169aa, 700b460, 7ae7c73, f972df6, 7bc842c M6 Indic language from SraVaani's script (v4) - needed because the gate sends more
      segments to the Indic pick, where longest-text M6 mis-tags (new-selftest at b9085b1: dlg_te_2 -> "ta" Conformer text).
      NOT af88f74/f777bb4/7b45a69/8e3b5f2 (ETR; separate question).
 R-B  R-A + clinical-span retention: on a segment where R-A picks the Indic side, a leading block of Whisper's (judged-text) drug[+dose]
      spans is prepended to that segment's text, found by the FROZEN fuserv2e matcher (router-fix/v2e 2eccd9dd, M5 list 42501e65:
      letter+skeleton match, English stop-list, D4-E coverage against the Indic text, dose only with agreement). BUILT ONLY IF v2-E passes
      its fresh-set gate (FUSER-V2E-PREREG; G4 safety). If v2-E fails, R-B is dropped, not re-designed here.

## 2. Evaluation surfaces (all box twins on spare ports; never the Mini, never Neon)
 E1 diag-rig nightly suite as run by nightly.sh (suite manifest sha recorded), 3 runs per arm (P keeps M4 non-determinism; R-A/R-B do not).
 E2 clinical1, 192 windows: per-window output language vs the mode (hi-en -> hi, kn-en -> kn). LANGUAGE checks only (G1/G2); its S1/cap
    numbers are reported as SECONDARY, labelled post hoc for R-B (the fuserv2e matcher was built from clinical1's failures; #7753 B1).
 E4 the FRESH DEV set (384 windows, eta-refuter-2 draw rule v2 1d16e236, generated for v2-E; P on it is produced anyway): the G3/G3m
    surface for R-A and R-B. Each arm is run mechanically through the same S1 harness; nobody reads its content before the scored run.
    BINDING (refuter-2 #7757): E4 is used first by the single v2-E run and later by R-A/R-B. Until the R-B run is done, NOBODY reads
    per-window E4 outputs (no per-window diagnosis of v2-E's result, unlike v2-D's #7618 on clinical1); only aggregate gate reports.
    A per-window read before R-B makes E4 post hoc for R-B.
 E3 label200 real clips (W30.1): 21 windows of Indic speech on P's English path, 29 true English; labels are my text reads
    (designer = labeller, declared). Before E3 is scored, a SECOND reader (V preferred; eta-refuter-2 only if V cannot) labels the same 50 clips blind to mine;
    G4 counts only clips where both agree, and the agreement rate is reported. The runner refuses any R3/W51 held-out room-day window (heldout.py f07171dc) before reading content.

## 3. Gates (all must hold for SHIP; eta-refuter-2 re-derives)
 G1 recovery: ta, hi-en, kn-en language accuracy >= 0.9 on E1 (all runs) and on E2 (per mode); E1 hit_rate >= that run's shadow-SraVaani
    hit_rate - 0.05.
 G2 no regression: en, hi, kn, te on E1: mean hit_rate >= P's mean - 0.02 and language accuracy >= P's; on E2 language accuracy >= P's;
    canary hit kept; silence/tones: no new text in silence.
 G3 clinical not-worse (the W31 lesson), on E4: S1 drug+dose ALL >= P - 1.0 and no language below P by > 3.0; cap captured_pct >= P - 1.0.
 G3m (R-B only; #7753 B3): R-B prepends its block PER SEGMENT, so later segments' blocks sit mid-transcript (v2-D's #7326 mechanism: a
    drug at one segment's end and its dose at the next segment's start; the follow-up tail). On E4: items P hits and R-B misses = 0 over
    all S1 item types (drug, dose, diagnosis, investigation, follow_up) and under the cap scorer; any > 0 = STOP, no ship claim.
 G4 real clips: E3 >= 2/3 of the Indic-speech windows leave the English path; <= 7% of the true-English windows do (= 14/21 and
    2/29 at full size). Denominators are the clips REMAINING after the held-out refusal (refuter-2 #7757: 10 label200 clips sit on the
    14 room-days) and after the two-reader agreement filter; both counts are reported.
    Minimum n (refuter-2 #7761): if fewer than 15 Indic-speech or fewer than 20 true-English clips remain, G4 is NOT EVALUABLE
    (= no ship claim), reported with the counts.
 EXPECTED, written now: R-A passes G1 (new-selftest at b9085b1 already shows ta/hi-en/kn-en native) and FAILS G3 (the §0 numbers are R-A
 minus M6 v4, which cannot restore Latin drug names). So R-A alone is not shippable under this pre-reg. R-B is the ship candidate.
 If R-B cannot be built (v2-E fails) or fails G3, SHIP is NO and the choice becomes explicit for Fable/V: correct language on Indic
 speech vs clinical-token capture. My recommendation in that case: do not ship R-A alone.

## 4. Build, review, ship
 Run parity (lid-debug #7889, refuter-2 #7894): E2/E4 R-A runs use the SAME harness (run_s1), host (c3, where P's E2/E4 outputs were
 made) and engine endpoints (ETA_WHISPER_URL / ETA_INDIC_URL / ETA_SRAVAANI_URL) as P, plus ETA_DEFAULT_CANDIDATES as run_s1 sets; if
 R-A must run elsewhere, P is re-run there with the identical env. E1: baseline 03310ca and R-A served side by side with identical
 explicit env (never the :8083 twin, never the Mini). Every run header records the full ETA_* env, router_server.py sha (P 400710ee,
 R-A d1c6d4e8) and harness sha.
 router-fix builds R-A as a branch off 03310ca (baseline) with the listed commits cherry-picked, on a second box twin port; R-B after
 the v2-E fresh result. eta-refuter-2 reviews the builds and re-derives the gates. One evaluation pass per arm; no tuning of 0.9 or any
 threshold after a read (any change = dated addendum, reported next to the first result). Ship only on a Fable GO naming it; scribe
 ships in a daytime train (Fable #7733).

## 5. Limits
 E1 is 1 clip per language (x noise); E2 is synthetic TTS; E3 truth is my text read. p(en) 0.9 comes from label200 (16/21 misroutes vs
 2/29 English flagged, W30.1) - set before this pre-reg, not tuned on E1/E2. The M4/M5 changes alter P's own English text slightly; G2
 measures that.

## A1 — addendum, dated 2026-10-06 (Fable CLARITY-1 ~12:10 and CLARITY-2 ~12:45; resolves eta-refuter-2 #8803 F1-F7). Written BEFORE any
## R-A E1/E4/E5 output is read or scored; ra-e4 (306) is untouched and unread. Binding definition (V): CLARITY is judged ONLY by automatic
## scores. S1 = synthetic, S2 = real consults vs Pulse prescriptions, S3 = Gemini language judge.
A1.1 Surfaces and scores (replaces §2's evaluation list where they differ):
 S1 = E1 + E4.
  - E1 = diag-rig nightly suite as pinned (rig f1dc92bc, manifest 836ef736), 3 runs per arm, arms interleaved, P' = 03310ca (400710ee) and
    R-A = 301f97e served side by side (§4 run parity). Scores: G1, G2 (§3, unchanged on E1, incl. G1's shadow-SraVaani clause) and S1-b.
  - S1-b WER per language = roman_wer / roman_cer per language from kit/diag-rig score.build_report on E1 ONLY (F2). REPORTED; not part
    of the ship rule (CLARITY-1 §2 gates on S2 + G1/G2/G3).
  - E4 = E4-FULL: a FULL 384-window rerun of the fresh fv2e set (suite.json a8406c38) for R-A from ~/oc/router-fix/wt-ra into
    fv2e/ra-e4-full, and a headered P rerun the SAME night on the SAME host into fv2e/p-e4-full, run SEQUENTIALLY (R-A first), nothing else
    on c3 :8081/:8082/:8085 (CLARITY-2 B). P for E4 = p-e4-full. The 30 Sep fv2e-p is reported beside it, never as P. The 30 Sep partial
    ra-e4 (306) is NEVER read or mixed into E4-FULL (F7).
  - E4 scores: G1 = per-mode routed-language ACCURACY against stimulus truth (hi-en -> hi, kn-en -> kn): ta, hi-en, kn-en >= 0.90
    (accuracy only, no shadow clause on E4; F3). G2 = en accuracy >= P - 0.02; hi, kn, te accuracy >= P. G3 unchanged (§3): S1 ALL (as
    fuserv2_dev_gates l.101) >= P - 1.0, no language below P by > 3.0, cap captured >= P - 1.0. No bar moves to rescue R-A (F3/CLARITY-1).
  - E2 clinical1: language checks only; its clinical numbers are reported, not gated.
 S2 = E5: run_s2 on the 24 CAP consults (~/eta-data/cap2/sample_audio, MANIFEST.tsv/WINDOWS.tsv), OLD = 400710ee and NEW = R-A 301f97e,
  BOTH arms the SAME night, a NEW out dir (not /tmp), header per §4 and the SCORING-MAP §3 field list (F1). The 27 Sep out-s2/old is
  reported beside, NEVER as P. Rule = PREREG-W33-S2 41884cf03410: WIN = NEW captured_pct - OLD >= +3.3 points AND drugs captured not
  lower; WORSE = <= -3.3 or drugs down by > 1; else NO-WIN. Scorer PINNED: cap_scorer 8c176820 @ c7bd6b2 (F6). Denominator: W33-S2 states
  24 consults, so 24 is PRIMARY; 23 (without cw-vafxdW8k1Nt4tpyOzHQb) is reported (F6). E5 runs only after E4-FULL writes FINISHED and
  only if it can finish by 07:55, else the next night (CLARITY-2 E).
  E5 blind guard (F4): heldout.py (sha16 f672c1ef046089dd, union f07171dc; c3 path ~/eta-data-ro/drtpqma/heldout.py) applied BEFORE any
  audio is read, through an EXPLICIT slug -> LABEL map covering every MANIFEST slug; any unmapped slug ABORTS the run (fail closed). A test
  proves the abort on an unmapped slug. Refused count goes in the header.
 S3 = INDICATIVE ONLY, never gating: judge v4 (PROMPT_SHA 5c99d768b83917a5) failed its own gate (confirm4 `mixed` 72.5%). If run, it is
  scored on switch=false windows only and shown with its validation error rate. V's rule (S2 improves AND S1, S3 hold) stands unchanged:
  any SHIP=YES outcome is HELD (not shipped) until a validated S3 judge passes its own gate. No waiver is taken (F5).
 label200 (E3) = REPORT-ONLY, optional spot-check. G4 and W31 P1/P2 leave the blocking path; their replacement is G1/G2 on E4 per mode
  with stimulus truth (above).
A1.2 Ship rule (CLARITY-1 §2): R-A ships only if S2 = WIN under W33-S2 AND G1, G2 (E1 and E4) and G3 (E4) all hold; then HELD per S3
 above. A clean NO is an acceptable result: it closes R-A and opens the next arm (R-C). Expected, stated before any run (§0, §3, SCORING-
 MAP-06-OCT): R-A's nearest build f972df6 is already W33-S1 WORSE on clinical1 (80.95 -> 73.13); a G3 FAIL on E4 is expected.
A1.3 E4 scoring order (the r3/#7878 no-read rule ends here): (1) E4-FULL R-A 384/384 and P 384/384 with refuter-2-PASSed headers;
 (2) one scoring pass per arm with the frozen scorers (clinical_score 622aeebf, cap_scorer 8c176820; language accuracy from stimulus
 truth), scoring-script sha posted before it runs, AGGREGATES ONLY (per mode accuracy, per language S1 ALL and cap captured, n per
 cell); (3) eta-refuter-2 re-derives, byte-identical; (4) only then may per-window outputs be read, for diagnosis only: no rescoring,
 no threshold change, no second run.
A1.4 Headers (all runs): code commit + router_server.py sha256 + eta_number_words.py sha (ccb1cc13 asserted, CLARITY-2 B), harness sha,
 suite/manifest shas, host, python3 version, FULL ETA_* env identical across arms except port/router file, engine endpoints and model
 shas, blind-guard sha + refused count, run index, start/end time, done-window list; E1 adds cache path and TTS ledger before == after
 and gpu.lock flock (CLARITY-2 C). A resumed run must keep the same code sha, env and harness, else it restarts from zero.

A1.5 Corrections to A1, dated 2026-10-06 ~13:10 IST (eta-refuter-2 #8829 A1-1..A1-4), still BEFORE any R-A output is read or scored:
 A1-1 E1 G2 English bar = en language accuracy >= P' - 0.02 (CLARITY-2 F3 applies on BOTH E1 and E4); E1's other G2 parts unchanged
      (hi, kn, te mean hit >= P' - 0.02 and language accuracy >= P'). E1's G1 keeps its shadow-SraVaani clause; E4's G1 has none.
 A1-2 Header fields: A1.4 is satisfied by the PASSed launch scripts (e1 f3b6fd76, e4 fcd4bacd, #8812) PLUS a side file written by
      router-fix at launch, without editing those scripts: SIDE-<run>.txt in each out dir holding the whisper-server argv and the model
      file sha256 per engine on that host (c3 and box), `python3 -V`, and, after the run, the sha256 of the sorted list of done window
      ids. Missing side file = the run is not scoreable until it is written from the same host state (stated, not inferred).
 A1-3 Malayalam on E4 (48 windows) IS gated: G2 on E4 = en >= P - 0.02; hi, kn, te, ml language accuracy >= P. (ml was §0's worst S1
      loss; decided here, before any read.) G3's per-language clinical bar also covers ml.
 A1-4 "S1 ALL as fuserv2_dev_gates l.101" is pinned to router-fix/repo eval/fuserv2_dev_gates.py blob 063919c4 @ f560a08, l.101 (drug
      items of every language + dose items except ta/ml).
