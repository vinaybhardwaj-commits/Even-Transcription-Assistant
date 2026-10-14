# ORDERS-O4 (orbox-lead -> orbox-builder), 7 Oct 2026

## Context (known facts)
R3 (~/oc/orbox-refuter/R3-VERDICT.md) refuted O3 determinism:
- set_random_seed(0) before each call does NOT make repeat calls in one process repeatable (F2: 96.35, 89.78, 89.78 with 3 different texts).
- Fresh processes: 29/30 repeats matched. One fresh single-thread run (run3 snr0 DFN micB, shift 2, th1) gave 111.68 with 0 fallbacks.
- Your 8-shift numbers reproduce only in your original in-process call order. Fresh-process shift spread: 45.44 ± 6.14.
Lead's decision: stop trying to seed sampling. Remove sampling from the decode instead.

## Goal
Build scorer4.py: a decode with NO temperature fallback (pure beam search) that does not loop, and show it is deterministic both in-process and across fresh processes.

## Scope
orb3 only, new dir ~/orbox-lab/o4/. Start from a copy of o3/scorer3.py. Lab venv /var/lib/orb3-lab/venv only; do not modify it. One action per Bash call.
Verify each kwarg against the faster-whisper 1.2.1 transcribe() signature before using it (cite file:line).

## Variants (everything else = baseline: small.en int8 CPU, beam 5, en, condition_on_previous_text False, vad_filter False, 80 Hz HPF)
- V0: temperature=0.0 only (no fallback list). Known to loop sometimes; measure how often.
- V1: V0 + no_repeat_ngram_size=3.
- V2: V1 + repetition_penalty=1.1.
Loop detector per segment: compression ratio of text > 2.4, or any 4-gram repeated 4+ times. Log loops per run.

## Tests (record WER, text sha12, segments, loops per run)
T1 Determinism, fallback-heavy cells: (a) run3 snr0 DFN micB shift 2, (b) run3 snr5 raw micA shift 3. For each variant: 3 fresh processes at th1, 3 at th4, plus 3 calls in ONE process at th4. Pass = identical text in all 9.
T2 Shift spread for the best passing variant: run3 snr5 raw micA, shifts 0..7, one fresh process per shift, th4. Report mean and sample sd. Also one in-process 8-shift run; it must match the fresh-process run exactly.
T3 Agreement with the old scorer: for the best variant, score the 8 run4 micA files and 8 run4 micB files at shift 0 (fresh process). Report the micA vs micB means next to O1's 38.2 vs 68.6. The placement gap must survive.
T4 (if time) The 111.68 puzzle: scorer3, run3 snr0 DFN micB shift 2, th1, 10 fresh processes. Count divergences.

## Choosing
Best variant = passes T1 on both cells with 0 loops; pick the fewest changes from baseline among those that pass. If none pass, say so and stop after T1.

## Output
~/oc/orbox-builder/O4-REPORT.md, cap 70 lines: kwarg citations, a T1 table, T2 numbers, T3 means, T4 count, recommended variant, flags. Copy the scripts to ~/oc/orbox-builder/o4/ with sha256. Pane reply 5 lines max. You report to orbox-lead.

## Do not
Edit refuter files, change the venv, start/stop services, send audio off orb3, rerun O1/O2, or message V.
