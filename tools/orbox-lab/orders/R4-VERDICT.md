# R4 VERDICT (orbox-refuter -> orbox-lead), 7 Oct 2026, on O4-REPORT
orb3:~/orbox-lab/r4/: my copy of scorer4.py (sha256 3f3a7b2c...f6, matches), my runner r4run.py (3aedb256...0820), r4_matrix.sh (2fc01483...6c68). Raw output: r4.jsonl (95 scores, full text + jiwer S/D/I/H), r4.log. Lab venv only. Run 21:49:48–21:59:27. The builder's jsonl was not used. Transcript excerpts: ~/oc/orbox-refuter/r4/d4_transcripts.txt.

## D1 kwargs: CONFIRMED
- faster_whisper/transcribe.py (1.2.1): WhisperModel.transcribe at :747. Its signature has repetition_penalty :757, no_repeat_ngram_size :758, temperature :759 (default list 0.0..1.0).
- The list is built at :982-983: `temperature if isinstance(temperature, (list, tuple)) else [temperature]`, so 0.0 becomes [0.0].
- In generate_with_fallback (:1402), the loop at :1432 takes the sampling branch only when temperature > 0 (:1433-1438). For 0.0 it uses beam_size/patience. With a single-item list, the for/else picks from that one result (:1515-1520), so there is exactly one pass and no sampling.
- The `sampling_temperature` lines :233 and :611 are in BatchedInferencePipeline, which scorer4 does not use.
- scorer4.score() passes temperature=0.0 plus VARIANTS: V1 {no_repeat_ngram_size: 3}, V2 {+ repetition_penalty: 1.1}. Everything else is baseline. This matches the report.

## D2 determinism: CONFIRMED (6 of 6 variant-cells, each with 1 distinct text in 11 runs: 3 fresh th1, 3 fresh th4, 5 in-process th4 with the other two cells scored between every call)
- Cell c (new) = run3 snr0 DFN micB shift 0. It fell back in 5 of 12 segments in R3 C2.
- V1: a 95.62 (b5e8a60ac703), b 57.66 (efd19e2393b2), c 92.70 (c5f6d43b8811).
- V2: a 96.35 (fee4f2677a9d), b 57.66 (db7cfc37ec39), c 94.89 (e088e5b6101f). Input shas are constant (a 221c21f8dedf, c 82cd4d281b78).
- Loops 0 in all 66 runs, by both the per-segment and the whole-text detector.

## D3 order independence: CONFIRMED
- V1, one process at th4, shifts 7→0: 60.58, 41.61, 59.85, 57.66, 56.93, 45.99, 59.85, 58.39 (listed for shifts 0..7). 8/8 equal to the builder's fresh numbers.
- The shift 3 text (efd19e2393b2) equals the D2 cell b text, and shift 1 (ac0c0ec8c218) equals R3's scorer3 shift-1 text.

## D4 what drives the WER (reference: 137 words, no repeated word 3-gram)
- Cell a V1 (35 words): DELETIONS. S/D/I 29/102/0. Whisper drops most of the speech and emits a few invented phrases ("See you later. Thank you.").
- Cell a V2 (149 words): HALLUCINATED TEXT shown as substitutions. S/D/I 104/8/20. It loosely follows the script's shape ("The patient has a 62-year-old ...") but the words are wrong. No repeated phrase.
- run4 spL_nzR_m5 micB V1 (118.25): HALLUCINATION. S/D/I 121/1/40, 176 words of invented narrative ("He said he's going out ..."). No loop.
- run4 spR_nzL_m5 micB V1 (108.03): HALLUCINATION. S/D/I 114/0/34, invented text with scattered script words ("blood pressure", "section"). No loop.
- So no case above 100% comes from a repeated-phrase loop. They are invented speech on −5 dB audio, which is unintelligible.
- Deletion collapse is not specific to V1. V2 collapses on cell c (35 words, D 102), and V1 does not (130 words).

## D5 placement gap: CONFIRMED
- V1 fresh: micA spR_nzL_0 40.15, both_0 72.26, both_10_g41 27.01; micB 67.88, 92.70, 32.85. All 6 equal the builder's numbers. micA beats micB in 3/3.

## D6 V1 vs V2, 8 run4 micA files, fresh, shift 0
- The text differs in 8/8 files. V2 − V1 per file:

| take | V2 − V1 |
|---|---|
| spL_nzR_0 | −1.46 |
| spR_nzL_0 | −2.19 |
| both_0 | −9.49 |
| spL_nzR_m5 | +11.68 |
| spR_nzL_m5 | +7.30 |
| both_10_g31 | −2.19 |
| both_10_g41 | −0.73 |
| both_10_g51 | −0.73 |

- Mean V1 53.56, V2 53.83. V2 is lower in 6/8 files, by ≤2.2 points except both_0.
- V2 returns an EMPTY transcript for spL_nzR_m5 micA (0 words, D=137).
- On both_0, V1 drops 49 words (D 49) where V2 keeps them (D 8).
- Totals over the 8 files, V1/V2: S 399/314, D 152/236, I 36/40.
- Recommendation: V1.
  - The reference has no repeated word 3-gram, so no_repeat_ngram_size=3 cannot block true speech here. repetition_penalty=1.1 penalises every repeated token, including real repeats ("and the" x4).
  - V2 produced the worst distortion seen: a whole file deleted.
  - V2's wins on intelligible files are ≤2.2 points, well inside the shift sd of about 7. The one larger win (both_0) is a V1 deletion collapse.
  - Both variants can collapse. V1 is the smaller change from baseline.

## Overall
1. Determinism is CONFIRMED for V1 and V2: one decode pass, no sampling. Identical text across fresh processes, threads and interleaved in-process calls, and the call order does not matter.
2. The builder's numbers reproduce (D3, D5). V0's loop is gone; above-100% WER on −5 dB takes is hallucination, not looping.
3. Use V1. Its known failure is deletion collapse on unintelligible cells, and V2 has the same failure, worse.

## Flags
1. Whole-file collapse is possible: V2 had 0 words on one file. Scoring should log nwords and D/I, and treat hyp words < 0.5 × ref as a separate failure, not just a high WER.
2. Shift sd under V1 is about 7 (O4 T2 sd 7.18; consistent with my D3 values). Single-file differences under ~15–20 points still cannot rank arms.
3. no_repeat_ngram_size acts on tokens, not words. Whether any token 3-gram repeats in the reference is UNVERIFIED (word level: none).
4. Builder word counts (32/134) use raw text.split(). Mine (35/149) use normalised text. Same transcripts.
