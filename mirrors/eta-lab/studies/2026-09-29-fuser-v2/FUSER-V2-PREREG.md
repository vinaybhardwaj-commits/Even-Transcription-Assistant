# FUSER v2 — pre-registration (dated 2026-09-29, lid-debug, designer; Fable #7262, T-FUSER-8)
Status: DRAFT r3 for eta-refuter-2 (r1 f2e1d25e: #7326 B1-B3 applied; r2 3547f8bc: #7344 B4 applied). Nothing in this file has been run. No v2 code exists. No DEV read of any v2 output before
refuter-2 witnesses this file and the print-only scorer diffs in §5.

## 0. Why v2, in one paragraph
DEV (clinical1, 192 windows; RUN 3, dev-capscorer-dose.txt 8e80c8e742f662ba, refuter-2 #7134/#7164): v1 is below production P in 7/8
languages (S1 drug+dose ALL 65.9 vs 81.0; S2 cap captured 21.2 vs 45.3). Mechanism (#7165 corrected by #7188, reasons verified #7207):
of 108 items P hits and v1 misses, 84 were present in an input track (86 in a Whisper track) and the model did not copy them; 16 were
in 7 windows the validator rejected whole (empty output); 8 were in no track. v1 rebuilt the transcript from nothing and let Whisper
drug/dose tokens in only through a two-witness or p(en) >= 0.9 gate, so it threw away what production already shows.
v2 inverts this: START from P's own output and ADD what P missed. No LLM in the primary arm.
HYPOTHESIS (tested by G1-G4, §4): appending lexicon-confirmed Whisper drug[+dose] spans that P's text lacks raises drug+dose
recall above P on DEV under S1 and the S2 primary scorer, without adding wrong drugs or doses beyond the G4 bound, and without losing any
item P already gets. It is FALSE if any of G1, G2, G3m or G4 fails.

## 1. Headroom (item level, read-only, lid-debug work/v1_vs_p_diag.py machinery; n = 504 Rx drug items, clinical1 truth;
## hit = S1 items_score drug+dose, ta/ml drug-only. Item-level numbers differ from the per-window report table; the gate uses the table)
- P 76.0; v1 58.5; P or v1 80.0; P or "some single track has it" 94.0 (any track alone 92.5).
- Of 121 P misses: 83 the drug is absent from P's text, 38 the drug is there without its dose.
- Items P misses but some track holds: Whisper tracks hold almost all (whisper-cap2 70, whisper-forced-en 69, whisper-auto 58;
  sravaani 16; indic-ctc-* 4-11). P chose SraVaani/IndicConformer for that segment (P output: 1-2 segments per window, one engine each).
- Limit, stated now: S1 scores a drug's FIRST mention only (clinical_score.py items_score: pos = _find(name, toks, 0.72)). An appended
  "drug dose" cannot lift S1 for the 38 dose-only misses; v2's S1 upside is the 83 drug-absent items. Inline insertion after P's own
  mention would need word times P does not carry, and would be scorer-shaped; not done.
- S1 is POSITION-dependent (refuter-2 #7326 B1, synthetic proofs): a dose counts only within pos+12 of the drug's first mention, and
  follow-up only in the last 14 tokens. Text added mid-transcript or at the end can therefore LOSE items P gets. Placement (D5) is
  chosen so P's text is untouched as a contiguous block, and G3m checks every item type.
- Lexicon/truth overlap (refuter-2 #7326 B3), disclosed: clinical1 has 19 distinct truth drugs; 17 are in the Pulse lexicon (659
  entries) as exact canonical names, at usage ranks 0-467 (not the top-19 of the list); ferrous sulphate and levothyroxine are not in
  it (v2-D cannot insert them). How clinical1's drug list was chosen is not recorded anywhere I could find; treat DEV insert recall
  and precision as OPTIMISTIC (small, common-drug vocabulary). TEST (real consults, open vocabulary) is the real check.

## 2. v2-D: deterministic "P + Whisper clinical inserts" (the primary arm)
Inputs per window: P's output (text + segments {start_s, end_s, text, engine}); the three REB Whisper tracks (whisper-forced-en,
whisper-cap2, whisper-auto; latest_ok per (layer, engine, config_hash)); the fuserv1 lexicon (lexicon.py load_lexicon, Pulse
rx_history, EXCLUDE_DATES as v1; NOT built from any truth). No SraVaani/Indic track is read (so ruling #6956 item 2 does not gate v2-D).
Steps (all thresholds are v1's frozen constants; none is new):
 D1 Candidates. For each Whisper track, each 1-2 token Latin span: lexicon match on the Whisper side ONLY (drug_match: full-word
    consonant skeleton similarity >= T_WHISPER 0.9; best beats runner-up by >= T_MARGIN 0.1, else ambiguous -> no candidate).
    No p(en) gate. Justification: P already ships Whisper text verbatim for most segments (127 of 192 DEV windows have >= 1 P segment
    whose engine is whisper); v2 ships only lexicon-confirmed spans of it.
 D2 Dose. After the matched drug in the SAME Whisper track, scan <= 4 tokens, stopping at another lexicon drug. Value = the first token
    with Latin digits (fused "500mg" included) or a fuserv1 number_parse parse with role "value" (digits + English-by-ear; its
    existing range). A parse with role "frequency" (e.g. "2 times") is skipped, not taken. Unit = adjacent mg/mcg/g/gm/ml/iu (fused or
    next token), else "". No dose found -> drug alone.
 D3 Corroboration variants (both computed; selection rule in D6):
    D-any: a candidate from >= 1 Whisper track.
    D-two: the same lexicon drug from >= 2 of the 3 Whisper tracks with span start times within 5 s (dose = the earliest track's).
 D4 Already in P? Skip the insert if P's text holds that drug: a Latin token (or 2-token join) with skeleton similarity >= 0.9 to the
    lexicon name, OR a native-script token/join with drug_match's Indic skeleton similarity >= T_INDIC 0.8. Inserts are ONLY for drugs
    P lacks (r1's dose-only insert is removed: S1 cannot credit it, the S2 primary's captured class is name-only, and it would put a
    second, possibly conflicting mention of a drug P already shows).
 D5 Placement and text. One insert per drug per window (the earliest-time Whisper mention; its dose if D2 found one). Written as
    "<lexicon canonical name> [<value> [<unit>]]." (v1's canonical-spelling convention). ALL inserts of a window go in ONE block at
    the START of the window's text, in Whisper time order, then P's text follows byte-identical. Reason (#7326 B1): mid-text inserts
    break P's drug-dose distances, end inserts push P's follow-up out of S1's last-14-token tail; a leading block changes neither
    (P's internal distances and its ending are unchanged). Residual risk, stated: an inserted name that fuzzy-matches (S1 0.72) the
    first word of a DIFFERENT truth item becomes that item's first mention. G3m measures it. P's own text is never edited or removed.
 D6 Selection (fixed now, uses safety only, never S1/S2): v2-D = D-any if it meets the safety bound G4 on DEV, else D-two; if neither
    meets G4, v2-D FAILS (no third variant without a dated addendum). Both variants are reported.
Output: REB track fused.v2d__<cfg8> {text, segments, inserts: [{drug, value, unit, track(s), token ids, t0/t1, sim, margin}]}.
English translation (text_en) and V7 are out of scope for v2 (declared). Fallback when any input is missing: P unchanged.
Code rule: v2 must not import clinical_score.py or cap_scorer.py (a test enforces it); scorers are evaluation-only.

## 3. Why this targets the mechanism and cannot do what v1 did
- Not-copied (84): the copy is a rule, not a model choice.
- Whole-window reject (16): there is no validator reject; the worst case per window is P unchanged.
- Losing P's items: not guaranteed impossible (S1 is position-dependent, §1). The leading-block placement is designed to avoid it and
  G3m is the check.

## 4. Gates on DEV (all must hold; refuter-2 confirms by rerun)
 G1 S1 (router-fix report script, composite drug+dose, ta/ml drug-only, 192 clinical1 windows): v2 ALL >= P ALL + 2.0 pts, and no
    language below P by more than 2.0 pts.
    ATTRIBUTED S1 (refuter-2 #7344 B4): the leading block can hand a drug-only insert a dose it never carried (the next insert's
    number, or P's opening words, within S1's pos+12). So for G1, a truth drug whose S1 first mention falls INSIDE the insert block
    gets its dose hit only if ITS OWN insert carries that value (value equality, as G4); otherwise dose = miss. First mentions in P's
    text are scored by S1 unchanged. G1 gates on ATTRIBUTED S1; raw S1 is reported beside it. No system change (the rendering is not
    shaped to the scorer).
 G2 S2 PRIMARY (cap scorer blob 8c176820, digits-only, unmodified, via fuserv1_dev_capscorer_dose.py): v2 captured_pct >= P + 3.3 pts
    (the registered S2 margin) and drug not lower than P by > 1 pt. The pre-registered SECONDARY (S1 number tables, Fable #7093) is
    reported, not gated.
 G3m No loss: items P hits and v2 misses = 0, over ALL S1 item types (drug, dose, diagnosis, investigation, follow_up) and under the
    cap scorer. Any > 0: stop, report, no gate claim. follow_up P vs v2 is reported separately.
 G4 Safety (evaluation uses truth; the system never does). An insert is a CORRECT DRUG only if its lexicon canonical name EQUALS
    lexicon.clean_ingredient(truth name) for a truth drug of that window (no fuzzy match). A dose is CORRECT only if its value equals
    that truth drug's dose value (and the unit, when both carry one). Gate, on the chosen variant, over all 192 windows:
    - false-drug inserts: point <= 2% AND Wilson 95% upper <= 7%, with >= 50 inserts (fewer: NOT EVALUABLE = FAIL);
    - wrong doses among inserts carrying a dose: point <= 5% AND Wilson 95% upper <= 12%, with >= 30 such inserts (fewer: dose inserts
      are switched OFF, drug-only inserts continue, and this is reported).
    (For scale: 0 errors in 60 gives upper 6.0%; 1 in 80 gives 6.7%.) Reported per language and per source track.
 Reported, not gated: v0 and v1 rows; insert counts per language; D-any and D-two both; inserts by source track.
 No tuning: one deterministic DEV run on the parameters above. Any change after the first read is a dated addendum, and its rerun is
 reported next to the first result, never instead of it. Blind rule (Fable #6727, #6956 item 4; warden #7293): held-out clips L041/L057/L139/L182 excluded (not in clinical1;
 stated for completeness) and no v2 code path reads any window on an R3/W51 held-out room-day (union f07171dc via
 ~/eta-data/drtpqma/heldout.py, sha-checked, IST start AND end-1s rule); the v2 runner refuses such a window before any content read. DEV is synthetic TTS: a DEV pass is necessary, not sufficient; TEST is the real check.

## 5. Scorer plumbing (print-only, witnessed before the v2 run)
 - eval/fuserv1_run3_hit_table.py (router-fix, last f75323a): add a v2 row reading fused.v2d text. Print-only diff.
 - eval-out/scripts/fuserv1_dev_capscorer_dose.py (sha16 5c46a87a): add a v2 row. Print-only diff; scorer blob unchanged.
 - P inputs pinned: s1-results/old/*.result.json (192 clinical1), sha256 list in the run record.

## 6. TEST (only after G1-G4 pass, refuter-confirmed, and a Fable GO)
 Same code sha on the 23 consults (cw-vafxdW8k1Nt4tpyOzHQb excluded). P = the pinned production S2 output. Preconditions to confirm
 before the GO (questions to cap / router-fix / reb): (a) does P's TEST output carry segments with times? If not, D5 appends at the
 end of the consult text, and the DEV run ALSO reports that end-only placement so TEST behaviour is measured on DEV; (b) all three
 Whisper tracks exist on all 23 cw-* windows. S2 WIN rule unchanged (+3.3 captured_pct, drugs not lower by > 1). G3 (V rates)
 follows T-FUSER-4's rules with the pair v2 vs P; the G3 dose component stays under #7169/#7185 (en-only dose gate) until Fable rules.

## 7. If v2-D fails
 A model arm (v2-M: the LLM EDITS P, same insert-only contract, per-item drop, fallback = P) is designed in a dated addendum only
 then. Not pre-registered here.

## 8. Build and cost
 Builder: router-fix (a small fuserv2/ module + tests: lexicon-only candidate finder, dose scan, P-coverage check, placement,
 no-scorer-import test). LLM spend: USD 0. Reviewer: eta-refuter-2. Builders never review their own work.
