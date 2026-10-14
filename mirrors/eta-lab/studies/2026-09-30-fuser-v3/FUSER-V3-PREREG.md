# FUSER v3 — pre-registration (dated 2026-09-30, lid-debug, designer; Fable #8153, V go 08:15; T-FUSER-20)
Status: r4, PASSED by eta-refuter-2 #8214 on r2 (r1 c446d74b; r2 addfbae2 #8204 M1-M4; r3 196d77b7 size on dfe18256; r4 text-only: §0 dose-credit sentence per #8214, dxinv recheck PASS). Nothing built or run. v2-E stays FAILED in the record (#7876); nobody reads v2-E per-window outputs.
Written under Fable #8153's rules R1-R5 as ordered (option (a) of #8159). Any bar change (option (b)) is a dated addendum BEFORE Fable's
seed commitment, or not at all.

## 0. Expected outcome, stated before anything is built (#8159, corrected #8171/#8175, checked by refuter-2 #8162/#8168)
Under R2 (two independent engine FAMILIES, §2) and R3's unchanged bars, v3 is EXPECTED TO FAIL G1 and G2. Estimate from v2-E fresh
aggregates (#7873) x the clinical1 share of Whisper-heard P-missed drugs that an Indic engine also heard (25/66 = 0.38, an upper bound):
G2 +3.2 x 0.38 = ~+1.2 (bar +3.3); G1 +2.8 x 0.38 = ~+1.1 (bar +2.0). (r1 wrongly said an added drug scores in S1 only for ta/ml:
S1 ALL pools DRUG items of every language plus DOSE items outside ta/ml (§3), so an added name earns its drug item everywhere.) v2-E's +2.8 INCLUDED
insert-carried dose credit (frozen gates 2eccd9dd eval/fuserv2_dev_gates.py l.56-63; dose_on at l.123 is printed only, never applied
to G1; refuter-2 #8214, correcting my #8159). R1 removes that credit, so ~+1.1 is an UPPER bound for G1 and the expected FAIL is stronger. These are rates: size (§5) makes G4 evaluable, it cannot lift G1/G2. So the run is, in practice, a SAFETY test
(G3m, G4) of the R1/R2 design. PASS still requires all four gates (§6).

## 1. Output and R1 (doses never touched)
v3's output per window = {"text": P's text, BYTE-IDENTICAL; "added_drugs": [lexicon canonical names]}. added_drugs carries names only:
no number, dose, unit or frequency. v3 never edits, removes or reorders P's text. (Downstream note-building uses both fields; out of scope.)
Unit tests (builder; witnessed): (i) output.text == P text byte-for-byte on every window; (ii) no token of any added_drugs entry is a digit,
a number word of fuserv1 number_parse, or a unit; (iii) G3m through the FROZEN scorers (§3) on synthetic windows including refuter-2's
#8156 cases (a P drug-dose pair, a follow-up in the last 14 tokens, a fuzzy-0.72 near-name): P-hit & v3-miss = 0.

## 2. R2 (drug added only if two independent engine families heard it in the same span AND it is in the Pulse lexicon)
Engine FAMILIES: Whisper = ONE family (forced-en a2131b2d, cap2 c7bd317b, auto 4b67551a); SraVaani (cee5af35); IndicConformer (all heads,
eaff21cc). P's own text is NOT an engine (it is derived from the same tracks). Config hashes as in clinical1's REB tracks; the fresh set
uses the same.
 W (Whisper side): the frozen fuserv2e matcher at router-fix/v2e 2eccd9dd: M1-M4, M5 exclusion list 42501e65, wordfreq 3.1.1 top-20k,
   lexicon fuserv1/lexicon.py as frozen there + cap2 rx_history.jsonl sha16 cd012fae. Any of the 3 Whisper tracks may supply it.
 I (Indic witness): in the SraVaani track or any IndicConformer head track of the same window, romanised with the pinned
   mic_selftest.indic_to_latin (blob 3b5b3c047bfd), a 1-3 token join whose consonant skeleton similarity to the SAME canonical name is
   >= 0.8 (v1's T_INDIC), beating every other lexicon name by >= 0.1. Same span: the Indic segment overlaps [t0 - 3 s, t1 + 3 s] of the
   Whisper mention; for windows <= 30 s, window-level timing counts.
 C (P coverage): no insert if P already holds the drug (fuserv2e D4-E, A1.1 widening). One entry per drug per window.
 Added = W AND I AND NOT C.

## 3. Scoring (a NEW union path; frozen with tests; witnessed by eta-refuter-2 before the run)
"Names it canonically" = lexicon.clean_ingredient(truth name) EQUALS an added_drugs entry (exact; stricter than S1's 0.72 on P's text).
 S1: per truth item (clinical_score item_hits types), v3 hit = P's S1 hit on P's text, OR (type drug AND named canonically). Dose items
   are scored ONLY on P's text (an added name carries no dose). S1 ALL (G1) = exactly fuserv2_dev_gates.py l.101: pooled over DRUG items
   of every language plus DOSE items of every language except ta/ml.
 cap (G2): captured_v3(item) = captured_P(item) OR the item's generic is named canonically. Same union, same exact rule.
 G4 unit: an added_drugs entry that equals no truth drug's canonical name in that window is FALSE.
 Scorer blobs unchanged (clinical_score 622aeebf via its runner; cap 8c176820); the union is a wrapper; no scorer import in v3 code.
 Wrapper test (#8204 M4): with an EMPTY added_drugs list the wrapper must reproduce the frozen scorers' P-only numbers EXACTLY (S1 per
 type, S1 ALL, cap captured/drug) on clinical1's P (s1-results/old) and on the fresh set's P; any difference = the wrapper is wrong, STOP.

## 4. Gates (R3, unchanged from v2-E) and minimum n
 G1 attributed S1 drug+dose ALL >= P + 2.0, no language below P by > 2.0.   G2 cap captured >= P + 3.3, drug not lower by > 1.
 G3m P-hit & v3-miss = 0 over all 5 S1 types and cap (true by construction, §1/§3; any > 0 = defect, STOP).
 G4 false entries: point <= 2% AND Wilson 95% upper < 7%, with n >= 50 entries, else NOT EVALUABLE = FAIL (v2-E's bar, unchanged;
 #8204 M2). The SIZING TARGET is >= 150 expected entries (§5), so that a few false entries can still pass the upper bound.
 Reported, not gated: G4 also by (case, mode, drug) cluster (noise variants of one dialogue are not independent), BY DRUG (drugs repeat
 across cases: ~130 candidates for 330 slots), per language, per Indic witness engine.

## 5. Size (R4): stated basis and numbers
 Basis: cache-DEDUPED chars (lang, speaker, text counted once), calibrated exactly on the 30 Sep set (62,367 = the ledger; refuter-2
 #8185). Naive is reported as an upper bound only.
 Chars: 272.6 per dialogue at 3 drugs on the PINNED inputs frames 2c146f28 + dxinv_v3 dfe18256 (router-fix #8206, dry_count4_out
 74830a99, reproduced byte-identically by refuter-2 #8213).
 N = 110 cases x 3 drugs x 8 modes = 880 dialogues; x 3 conditions (clean / fan10 / babble5) = 2,640 windows. Deduped projection 133,559
 chars (linear between #8206's N=100 123,121 and N=150 175,311; refuter-2 #8213), ~11% under the 150,000 hard cap. Naive would be
 ~240k: the size depends on the deduped basis and on dx/inv drawn WITH replacement.
 Yield: v2-E D-any inserted 69 per 1,128 drug slots (47 drugs x 24; 6.1%; D-two 3.55%); x 0.38 for R2 = ~2.3% of slots. N=110: 7,920
 slots -> ~180 expected entries (target >= 150). If R2's true factor is half the clinical1 upper bound, ~90 (still >= 50, but a few false
 entries then fail the upper bound); declared risk.
 SPEND GATE (refuter-2 #8185): router-fix reruns the dry count on the REAL draw (real pools, real draw, real back/days rules) and the
 deduped projection must be <= 150,000 before any TTS; else N is reduced by rule: N = floor(N x 135,000 / projection), stated.

## 6. Fresh set (R5) and PASS
 Author cap, from scratch: frames_v3 2c146f28 (similarity PASS, refuter-2 #8200), dx/inv pool dxinv_v3 dfe18256 (0 substring hits in
 either direction vs excl_dxinv 71e50f5a and the 30 Sep dxinv f415f36f; cap #8202, refuter-2 recheck PASS #8210) drawn WITH replacement
 (dx/inv are not in the gates; #8188/#8192). Exclusion = plain substring, both directions.
 Pinned draw inputs (cap asked, #8202): rx_history.jsonl cd012fae, lexicon.py 8191774c, excl_names eed2dcbb (clinical1 + confirm1-3 drug
 names, as in the 30 Sep draw), the 30 Sep case table a85b8eb8 (its 47 drugs are spent), excl_dxinv 71e50f5a, 30 Sep dxinv f415f36f. Drugs: Pulse lexicon with use >= 10, excluding clinical1, confirm1-3 and the 30 Sep
 drugs (spent); distinct within a case, with replacement across cases; usage-weighted; strata: the <= 6-letter stratum is empty after the
 exclusions (all 3 were drawn on 30 Sep), so mid (7-10 letters) >= 1/3 of drug slots, the rest long (> 10), declared. Doses: most common
 Pulse strength snapped to the S1 19-value table (as rule v2). Follow-up days from {3,5,7,10,14,21,30,45}.
 Order: v3 code frozen + witnessed (refuter-2 and eta-refuter-3) -> Fable commits sha256(seed) -> cap posts frames + draw script shas ->
 seed reveal -> mechanical draw -> real-draw dry count (spend gate) -> generation at the pinned generator e6971bc8, prefix fv3_, catalog
 room_synth_fv3 -> P (400710ee) and all 9 engine tracks at the pinned config hashes -> ONE v3 run -> gates, aggregate only.
 INDIC TRACKS (#8204 M3): the v2-E fresh store holds only the 3 Whisper tracks, so v3 needs NEW SraVaani and IndicConformer tracks on all
 2,640 windows: SraVaani (1) + IndicConformer heads hi, kn, ml, ta, te (5) = 6 tracks per window, 15,840 tracks. Owner: router-fix, on the
 box engines, through the SAME reb kit ingest route that wrote clinical1's tracks. PARITY is checked by config hash: every SraVaani track
 must carry cee5af35 and every head eaff21cc; the runner refuses otherwise. The engine service shas and URLs go in the run header. If
 the hashes cannot be reproduced, stop and post (no substitute config). GPU/CPU time is Fable's to schedule.
 PASS = G1, G2, G3m and G4 all hold, re-derived by eta-refuter-2. Anything else = FAIL; no tuning, no second run. Nobody reads per-window
 fresh outputs before the scored run (and none after, until Fable says otherwise).

## A1 — amendment, dated 2026-09-30 (after the PASS #8214/#8223; BEFORE Fable's seed commitment and before any draw)
 Drug pool (cap #8222): with the §6 pins there are 131 eligible drugs (67 mid 7-10 letters, 64 long > 10); 330 slots need >= 110 mid,
 so repeats are unavoidable. §6's "usage-weighted" is REPLACED by cap's option (a): per stratum, the pool is shuffled by the seed and
 dealt round-robin into slots (exactly 110 mid + 220 long; each mid drug ~1.6x, each long ~3.4x); distinct within a case; no Pulse-use
 weighting. Reason: this is a SAFETY test, and balanced coverage spreads G4's entries over the most distinct drugs (weaker by-drug
 clustering, refuter-2 #8204) instead of concentrating on the commonest names. Rejected: (b) use-weighted (less diversity), (c) lower
 the use threshold (junk names), (d) 2 drugs/case (more chars, less dedupe).
 Other draw values as the 30 Sep rule v2 (1d16e236): duration days {3,5,6,7,10,14,15,20,30}; follow-up days {3,5,7,10,14,21,30,45}; dose =
 the nearest S1 19-value table value; dx/inv seeded rng.choices from dfe18256. Domain string "fuser-v3|" + seed. The real-draw dry count
 (spend gate) uses exactly these values.
 A1.1 (dated 2026-09-30, before Fable's seed commitment; refuter-2 #8234, lid-debug #8229): EACH CASE = exactly 1 mid + 2 long drugs
      (110 cases -> 110 mid + 220 long); the order of the 3 drugs within a case is seeded. Mid therefore cannot collide within a case; the
      2 long drugs are asserted distinct, and on a round-robin wrap collision the deal takes the next different drug and logs it (per-drug
      use counts stay within +-1 per stratum). The draw refuses rather than emits if any of these fails.

## A2 — amendment, dated 2026-09-30 (before Fable's seed commitment; refuter-2 #8286)
 "Same span" in practice = SAME WINDOW, declared. Evidence: (1) the SraVaani cee5af35 and IndicConformer eaff21cc tracks carry ONE segment
 per window covering the whole window (clinical1 REB: 192/192 windows, 1 segment, ~30 s), while Whisper has ~9 segments of ~5 s; so the
 §2 overlap test [t0 - 3 s, t1 + 3 s] is always met by the Indic segment; (2) refuter-2's duration fit projects v3 windows at median
 20.4 s, max ~29 s, so §2's "<= 30 s: window-level timing counts" applies to all of them anyway. R2 is therefore: Whisper AND an Indic
 engine both map to the SAME canonical lexicon name within the same ~20 s window (not within a few seconds). Judged acceptable: R2's
 protection is two independent engine FAMILIES agreeing on one exact lexicon entry; time alignment inside a 20 s dialogue adds little.
 No code change (router-fix fe16277f already behaves this way). Reported with the result: entries where the Whisper-side drug appears
 more than once in the window. The SraVaani long-window probe (#8276) is no longer needed (0% of v3 windows projected over 44 s).
 A2.1 Ruled by Fable #8315 (09:55, new thread): A2 ACCEPTED (same span = same window, dated addendum to R2 before the seed); w_mentions =
      per-track matched-span counts, MAX over tracks (#8297/#8301); bars unchanged (G1/G2 may FAIL); SraVaani probe closed. Freeze = the sha
      with the overlap test, PASSed by both refuters (73adb29f, code = c97aec60). Seed commitment sha256(seed)[:16] = 0453361fcac11be7.
