# FUSER v1 — ADDENDUM 9: re-freeze position, TEST comparator, G3 source text (dated 2026-09-29, lid-debug, designer)
r3 (refuter-2 #6622 C1-C4 applied; #6637 TEST n = 23). Fable rules. Written after B4-RUN3-REPORT.md (router-fix #6600). TEST is still unseen for v0/v1: reb/2026-09-25 holds 8 cw-*
windows (STT tracks only, written 12:04-13:58 29 Sep; corrected per refuter-2 #6622 C1), and no v0/v1 TEST output exists anywhere. Every change here is made before TEST.

## 1. Re-freeze position (recommendation)
- Code: router-fix/lid @ b4249b66 (fuserv1/ == witnessed f9b6706e), RESPONSE_FORMAT schema.py @ dd22636, V7 policy "8a".
- Evidence: V7 "as built" is unusable (171/222 fallback; native raw 11.8, composite 47.1 < no-V7 65.9). Under 8a the native output
  equals no-V7 (raw 65.4, composite 65.9) and only unsupported English clauses are removed (English 27.4).
- Declared in the freeze record: fused.v0 absent as a model input (RUN 1-3; keep absent at TEST to match DEV); runner must substitute
  fused.v0 on fallback at TEST (fallback = empty in RUN 1-3), runner sha witnessed; TEST v0 = REB tracks (T-FUSER-2, #6159).

## 2. v0 has no English path, so it is not the production-equivalent baseline
Evidence: dev-v0-baseline.json (401c4c028f5d48f6), clin_en_1 v0_text = SraVaani's Telugu-script transliteration of English speech
("గుడ్ మార్ర్నింగ్ ..." = "good morning"); DEV en row v0 = 0.8% drug+dose hit. fuser_v0.fuse_window (c403e9b) uses Whisper text only
as ETR number evidence; the M6 pick always emits the Indic side. The production router (400710ee) used Whisper when the segment was
English. v0 = "Indic-only rules fuser", a weaker baseline than what runs in the clinic today, especially for en / hi-en / kn-en.
Change (design §6 and ADDENDUM-5):
 a. S2 WIN rule: primary comparator = PRODUCTION output P for the same 23 TEST consults (cap's existing CAP-1/W33 S2 production run, scored
    by the same cap scorer); v0 kept as a secondary row. WIN = v1 beats P by the pre-registered margins (+3.3 pts captured_pct, drugs not
    lower by > 1). Report v1 vs v0 alongside.
 b. G3 (ADDENDUM-5): the rated pair is v1 vs P (what V would otherwise keep using), same blinding, same item rules; v0 not shown to V.
 c. S1 (TEST clinical suite): report v1 vs v0 AND v1 vs the production router on the same suite (the S1 runs already score the old
    router; reuse that pipeline). The S1 not-worse rule applies against the production router.
 d. ETR verdict (ADDENDUM-1: V0 vs V0-noETR) is unaffected: it compares two v0 arms.

## 3. G3 source text: native, not post-V7 English
RUN 3 under 8a keeps only 27.4% of drug+dose in English clauses (hi: 20 of 22 slices lose >= 50% of clauses; kn 21/24; ml 20/24),
mostly because native number words are unparsed (parser v1 = digits + English-by-ear; "number" drops 564 vs "drug" 90). Extracting
v1's G3 strings from post-V7 text_en would make V rate mostly "(nothing)" for v1: G3 would measure V7's parser scope, not v1's accuracy.
Change: G3 extracts "<drug> <dose> <unit>" for EACH system from its NATIVE (validated) text, with ONE shared extractor that reads native
script (cap's S2 matcher, as #5646). v1 native = post-V1..V6 kept items (no invented native content can exist: V3 bars gen of clinical
tokens). P native = production text_native. English is audited separately: a V7 sample (condition B's 26 Change-2-only clauses + a random
30 kept clauses) rated by V for invented/wrong content, reported, not part of the G3 verdict.
This supersedes refuter-2's #5826 line "G3 itemset must be built from post-V7 text_en".

## 2b. TEST n = 23 (reb #6629, refuter-2 #6637)
TEST S2 has 23 consults: cw-vafxdW8k1Nt4tpyOzHQb is excluded (its mp3 is longer than its source chunks). P, v0 and v1 are all scored on
the SAME 23; that consult is excluded from P too, so n matches on every side. Every "24 consults" elsewhere (design §6, ADDENDUM-5 G3
scope, T-FUSER-2 v0 tracks: 46, not 48) reads as these 23. Drug denominator = the Rx drug items of the 23 (recomputed and stated in the
freeze record, replacing the 32 of the 24).

## 3a. Conditions carried (refuter-2 #6622)
C2 (blocker for TEST, reb): the cw-* sravaani tracks are config cee5af35 (single-shot, found EMPTY on long windows, reb #6228). TEST v1 and
   v0 need the chunked sravaani config b3584dd6 (reb dd8b4c09) on every cw-* window before either runs; otherwise TEST runs without
   SraVaani, unlike DEV.
C3: P's S2 number is already known (CAP-1/W33). Pin P's output files (sha256) and the cap scorer sha in the freeze record; WIN margins
   exactly as pre-registered; P is never rescored after v1 is seen.
C4 English audit pass bar (fixed now): V rates the 56 sampled English clauses (26 Change-2-only + 30 random, seed recorded) as
   correct / wrong / invented against the audio. ANY invented or wrong dose or drug in the sample -> English text (text_en) is NOT shipped
   to doctors from v1 (native only), whatever the S1/S2 result; zero -> English may ship, with the V7 omission rate stated. Report-only
   items (e.g. awkward wording) do not gate.

## 3b. ETR note (refuter-2 #6614 F2)
The DEV v0 ETR-off arm scores identically to ETR-on in every group although the text differs in 17 windows. router-fix confirms per
window; if the hit effect is truly 0, ADDENDUM-1's ETR verdict on DEV reads "no measurable hit effect", and TEST decides.

## 4. Not changed; next work after TEST
Parser v2 (native number words hi/kn/ta/te/ml, 0-10000, enumerated spellings, decoy-swept) is the main lever for English recall under V7
and for ETR. Out of scope for this freeze; declared.
