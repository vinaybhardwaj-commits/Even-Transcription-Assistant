# ORDERS-R4 (orbox-lead -> orbox-refuter), 7 Oct 2026

## Goal
Independently refute or confirm orbox-builder's O4 (~/oc/orbox-builder/O4-REPORT.md): a no-sampling scorer (temperature=0.0 single pass) is deterministic, does not loop, and keeps the run4 placement gap. Then decide between V1 and V2 on transcript evidence.
V1 = temperature=0.0 + no_repeat_ngram_size=3. V2 = V1 + repetition_penalty=1.1. Baseline otherwise (small.en int8 CPU, beam 5, en, condition_on_previous_text False, vad_filter False, 80 Hz HPF).

## Scope
orb3 only, new dir ~/orbox-lab/r4/. Copy ~/orbox-lab/o4/scorer4.py and check sha256 3f3a7b2cbdb2430e1698a64e097b809ce83a7c572399398a22ee257a5b2af2b6 before use. Write your OWN runner; do not reuse the builder's jsonl. Lab venv /var/lib/orb3-lab/venv only, unmodified. One action per Bash call.

## Checks
D1 Kwargs. Confirm in faster_whisper/transcribe.py 1.2.1 that a single float temperature gives exactly one decode pass with no sampling (cite the line where the temperature list is built and the line where sampling is chosen). Confirm scorer4.py passes what the report says.
D2 Determinism, V1 and V2. Cells: (a) run3 snr0 DFN micB shift 2, (b) run3 snr5 raw micA shift 3, plus (c) one NEW cell of your choice that fell back in R3 or O3 (cite it). Per variant per cell: 3 fresh th1, 3 fresh th4, and 5 calls in ONE process at th4, with a DIFFERENT cell scored between each in-process call (interleaved, to break call order). Pass = 1 distinct text per variant-cell.
D3 Order independence. One process at th4 scoring run3 snr5 raw micA shifts 7,6,5,4,3,2,1,0 (reverse order) with V1. Must match the builder's fresh numbers: 60.58, 41.61, 59.85, 57.66, 56.93, 45.99, 59.85, 58.39 (listed for shifts 0..7).
D4 Loops and deletions. Read the actual transcripts (hyp vs ref, side by side, first 300 chars each is enough) for: cell a V1 (32 words), cell a V2 (134 words), run4 micB spL_nzR_m5 (118.25) and spR_nzL_m5 (108.03) under V1. For each, say what drives the WER: deletions, insertions of a repeated phrase, hallucinated text, or substitutions. Count S/D/I with jiwer if it is in the venv; otherwise by your own alignment.
D5 Placement gap. Rescore 3 run4 takes fresh with V1 (spR_nzL_0, both_0, both_10_g41), micA and micB. Builder: micA 40.15/72.26/27.01, micB 67.88/92.70/32.85.
D6 V1 vs V2 recommendation. Score the 8 run4 micA files with V2 too (fresh, shift 0). Report how often V1 and V2 differ and by how much. Recommend one variant with a reason grounded in D4 (which one distorts real speech less).

## Verdict rules
Each check: CONFIRMED, REFUTED (with numbers) or UNVERIFIED. Any second distinct text in D2 or any mismatch in D3 = REFUTED determinism.

## Output
~/oc/orbox-refuter/R4-VERDICT.md, cap 70 lines: one block per check D1–D6, a 3-line overall verdict, then flags. Raw output stays in ~/orbox-lab/r4/. Pane reply 5 lines max. Post a one-line bus note to orbox-lead as you did for R3. You report to orbox-lead.

## Do not
Edit builder files, change the venv, start/stop services, send audio off orb3, or message V.
