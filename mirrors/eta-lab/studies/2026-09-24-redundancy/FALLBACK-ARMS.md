# Whisper temperature fallback: four arms on 58 labelled windows (ruling 16 + 07:30 add-on; split-speaker, 24 Sep)

> **RULED (Fable ruling 72, 24 Sep 12:00):** production keeps **arm A** (fallback on). **Arm B (`temperature_inc=0`) is the
> EVALUATION and PARITY config for every lab/twin comparison** — send `temperature_inc=0.0` in the request whenever two whisper
> runs must be comparable. The wrong "no fallback" comment in lib/whisper.ts is corrected in 67e1980 (rides tonight's train).

Box T4 (even windows) and gcp-l4 L4 (odd windows) twins, through their SHIMS (the path production takes), never the Mini
(ruling 15). The 58-window VAD-v3 set (whole 900 s windows), every arm run TWICE per window, one request in flight per
machine; all arms of a window ran on the same machine. Numbers only; transcripts never left memory. 0 errors.

| arm | coverage of labelled speech | words | repeat ratio mean / p90 | windows repeat > 0.3 | filler-only segments | segment time outside speech | run-to-run WER (mean / median) | windows identical twice | s per audio-min T4 / L4 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A current** (fallback on) | **77.9 %** | 34,130 | 0.20 / 0.45 | 22 | 348 | 225 min | 61 % / 74 % | 1 / 58 | 1.36 / 1.01 |
| **B temperature_inc=0** | 72.8 % | 34,144 | 0.26 / 0.57 | 26 | 355 | 208 min | **0 % / 0 %** | **58 / 58** | **0.98 / 0.72** |
| **C inc=0 + beam 5 / best-of 5** | 83.8 % | 46,888 (+37 %) | 0.37 / 0.68 | 35 | 354 | 255 min | 85 % / 85 % | 0 / 58 | 1.42 / 1.08 |
| **D current + seed=42** | 78.4 % | 34,712 | 0.21 / 0.51 | 21 | 340 | 223 min | 59 % / 68 % | 3 / 58 | 1.27 / 0.98 |

Definitions: coverage = the share of pyannote.ai-labelled speech time covered by returned segments; repeat ratio = the canonical
`repeatRatio` (lib/stt/hallucination-collapse.ts: 1 − distinct/total folded 3-grams), ported exactly and cross-checked
against the TypeScript; filler-only segment = a segment whose whole folded text is filler ("thank you", "bye", "you", …).
**WER against truth: NOT MEASURABLE** on this set: none of the 58 windows has a gold transcript (stt_gold_window holds 5 "seed" rows in total).

## What it says
1. **The fallback is the non-determinism, and it is also the loop escape.** B (fallback off) is identical on 58/58 windows
   and ~28 % faster, but covers 5.1 points LESS labelled speech and loops MORE (26 vs 22 windows over 0.3). Same total words,
   so B spends words on repeats that A escapes by re-sampling.
2. **Beam search (C) is NOT deterministic here** (85 % run-to-run WER, 0 windows identical) and loops the most: +37 % words,
   35 windows over 0.3. Its higher coverage is mostly repeated text over speech, not recovered speech. Cause of its
   non-determinism: unverified (candidate: beam scoring on CUDA). Not a candidate for production as it stands.
3. **The seed is ignored (D ≈ A)**: whisper.cpp's server does not honour `seed`, as lib/whisper.ts already notes.
4. **No arm is both reproducible and at least as good as today.** A stays the best coverage-to-loop balance.

## For Fable's ruling
- Production: keep A (current) — suggested; B would trade 5 points of speech coverage and more loops for reproducibility.
- Measurement: use B (temperature_inc=0) as the EVALUATION config whenever two runs must be comparable (parity, A/B tests);
  otherwise run-to-run noise (61 % WER) swamps any effect under ~20 points.
- Possible next arm, not run: fallback ON with a deterministic sampler, which needs a whisper.cpp patch (per-request seed), or
  B plus stronger loop suppression. Only if reproducibility in production is wanted.
- lib/whisper.ts's comment "no fallback to a hotter temperature" is factually wrong and should be corrected.

## For V: 3 windows where A and B (the reproducible arm) differ most (ids + minute; listen to that minute)
| window | minute | words that minute A / B | repeat ratio A / B | coverage A / B |
|---|---:|---:|---:|---:|
| bw_7tedad86_1790160300000_primary | 13 | 8 / 144 | 0.28 / 0.65 | 38.6 % / 51.1 % |
| bw_6nm7h269_1790169300000_primary | 2 | 3 / 38 | 0.00 / 0.48 | 63.9 % / 74.1 % |
| bw_7tedad86_1790165700000_primary | 14 | 14 / 78 | 0.29 / 0.52 | 49.7 % / 35.9 % |
In all three, B's extra words come with a high repeat ratio: most likely a B loop, not speech A dropped. The listen decides.
