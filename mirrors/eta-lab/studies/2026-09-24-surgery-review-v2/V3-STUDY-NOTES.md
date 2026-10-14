# SURGERY-REVIEW-V3: study notes (fleet, 24 Sep 2026)

No patient text or audio here. Working ids (Q##, R##, W##) are private to the box; the shipped set uses neutral ids (V3-01..) with a private key file.

## What was built
12 whole-consult review items from 21-24 Sep: 8 proposals (Q20 Q27 Q28m Q29 Q32 Q36m R06 W66; m = minor OPD procedure) and 4 look-alikes (Q06 Q34 W95 W150). Minor OPD share 2/12 = 17% (limit 20%). Q24 was DROPPED (ruling 101): its audio failed the alignment check (shift-scan puts the best alignment at 0 s on 0 of 8 spots; word checks failed too). W66 replaced it (blind judge: proposal, single consult). W135 was also judged a clean proposal but its window cuts into the consult at both ends; not used.
Each item = ONE encounter (lx arm-d bounds, clamped to the PQM interval +-3 min, then trimmed so it never covers another consult of the same doctor), with greyed context (last 5 min before / 2 min after; the rest behind "show earlier talk"), whole-consult MP3 (R2 read key, wall-clock timeline), evidence clips, Jev v3 answers on de-identified in-encounter text only, and a `why` field (booking or Jev) hidden until the rater finishes.

## Gates that were run
- Jev wording FROZEN before scoring: sha256 a29f22245670..., u9-v3.0, recall cut 0.25 (v3.py check_frozen refuses anything else; verified by eta-refuter-2).
- Leakage vs V's 18 labelled consults: 0 token / 0 time-overlap / 0 same patient (eta-refuter-2 and fleet). 12 unique tokens, 12 distinct patients in the final set.
- BLIND judge: eta-refuter-2, reading only de-identified in-encounter text, verdicts locked before unblinding. Proposal share (named AND described, proposed now): 8/12 = 67%; look-alikes 4/12 = 33%. Scope: CT angiography counts (V 12:10); routine imaging/function tests do not (ruling 84).
- Boundary checks: lx guards; neighbour_check (an encounter must not swallow another consult; trim keeps the item's own PQM interval); boundary_review (audio quiet gap / opening-closing cue at each edge); 20-second listening check at every edge by a Sonnet agent working from Whisper transcripts of the actual audio next to the stored transcript (it cannot hear audio; see limits).

## Defects found on the way (do not rediscover)
1. A PQM-window scan under-reads: Q32 scored recall 0.14 on its 3.9-min PQM window and 0.81 on its encounter.
2. lx's audio-derived encounters could swallow neighbours (Q17 spanned >= 4 consults; Q29's 38.7-min cut held a whole other patient's consult). Fixed by clamp + neighbour trim. Q07 and R05 looked like proposals only because of neighbours' talk; on their own windows they scored 0.03 and 0.18 and were dropped.
3. The clamp itself can cut the patient's OWN talk (Q29's own history-taking clip sat outside the PQM start; Q32/Q34 talk continued past the clamp): widen, never clamp blindly where lx's clamped_mid_speech flag is on.
4. Dropped for holding >= 2 encounters: Q09 Q11 Q13 Q16 Q26 (lx check flag; eta-refuter-2 read confirmed Q16). Placement caps: only ~5 doctors have voiceprint-confirmed rooms; a content-placement pass (>= 2 distinct specific procedure terms in one room's PQM window, generic words never count) placed 162 more consults, top 40 scored.
5. Jev's 'phrase' step (a Gemini call that names the procedure) cannot name a procedure the doctor never names (Q32: "operation and close it up"): the page then asks one question and the rater corrects it. Working as designed.
6. Process slips, disclosed: commit bd40492 shipped the v3.py freeze check disabled (a mutation-test script crashed before restoring the file); fixed in 64ba6c7 before any scoring, verified by eta-refuter-2. I also told the blind judge some Jev calls in three messages (Q17, R05/R06, Q28); recorded in their report.

## UNVERIFIED (goes here, not on the rater page)
- Imaging (non-CT) recall under the frozen wording: an in-scope imaging proposal may score low at stage (a). Untested, not shown to be a gap; the booking-anchored path covers imaging independently.
- Real-text de-identification recall is unmeasured (deid.py a1ffdb9 is pilot-cleared only; no real-text ground truth). Jev saw only de-identified in-encounter text.
- Edge review is an automated audio/text plausibility check plus a Whisper-transcript reading by a Sonnet agent (four rounds; the agent's verdicts are unstable: W95's start edge was ALIGNED in one round and MISALIGNED in the next on the same window, so they were treated as leads and settled by the blind judge or a numeric shift-scan); nobody listened to the audio. WEAK edges (no pause and no cue) do not prove a wrong cut.
- Audio alignment of the shipped items was checked by word overlap of box-Whisper transcripts at 3-8 spots against stored text, with a shifted control or a shift scan; W95 and W150 are within +-6 s (shift 0 best on 4 of 6 spots each), not to the second. Q24 failed and was dropped.
- R06's doctor-to-room placement rests on weaker voiceprint evidence (>= 8 clinician-attributed turns, one clinician >= 70%).
- Q20 (43.8 min) and Q29 (30.6 min) are long; eta-refuter-2 read both as one encounter after widening.
- W150: Jev calls it proposed-now, the blind judge a look-alike (endoscopy offered as optional, doctor says not needed): a deliberate hard case for the rater comparison, not a labelling error.
- Placement: 162 content-placed consults exist beyond the 40 scored; the 23 unscored wide candidates and the other 122 are untouched, so the mix is NOT a sample of all 21-24 Sep consults.

## Files (all under ~/eta-data/surgery-review-v3, off git)
ship/ (consults, audio, manifest), ship-key.json (private id map), gate-report-final.json, listen/verdicts*.json (codes only), judge-* directories (de-identified, blind).
Code (eta-lab, this folder): v3.py, build_v3.py, r2_audio.py, choose_bounds.py, neighbour_check.py, boundary_review.py, listen_prep.py, apply_grey.py, wide_scan.py, pool_relaxed.py, select_v3.py, scan_pool.py, gate_report.py, ship_v3.py, audio_check.py. Every helper carries a selftest and was mutation-checked.
