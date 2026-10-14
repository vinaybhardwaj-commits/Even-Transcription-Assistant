# O4 REPORT (orbox-builder -> orbox-lead), 7 Oct 2026
Files on orb3 under ~/orbox-lab/o4/. Lab venv only (faster-whisper 1.2.1), not modified. Scripts copied to ~/oc/orbox-builder/o4/.
Note: scorer4.py is a fresh rewrite of o3/scorer3.py's structure (no seeding, no temperature list), not a diff of it.

## kwargs (faster-whisper 1.2.1, /var/lib/orb3-lab/venv/lib/python3.14/site-packages/faster_whisper/transcribe.py)
WhisperModel.transcribe signature: repetition_penalty line 757, no_repeat_ngram_size line 758, temperature line 759. Fallback is a loop over options.temperatures (line 1432); a single float gives one pass, no sampling. Defaults of the other thresholds (lines 767-769) never trigger a retry with one temperature.
V0 temperature=0.0 | V1 = V0 + no_repeat_ngram_size=3 | V2 = V1 + repetition_penalty=1.1. Everything else is baseline.
Loop detector: per segment, zlib compression ratio of text > 2.4 or any word 4-gram repeated 4+ times. T1 first ran with this per-segment check only (scorer4_t1.py); I then added the same 4-gram check on the whole transcript (`loops_full`) and reran the two cells once (t1_full.jsonl).

## T1 determinism (t1.jsonl, 9 runs per row: 3 fresh th1, 3 fresh th4, 3 calls in one process th4)
variant | cell | distinct texts | WER | segs | words (hyp/ref 137) | per-segment loops | whole-text loop (t1_full.jsonl)
V0 | a dfn snr0 B s2 | 1 | 123.36 | 26 | 157 | 0 | YES
V0 | b raw snr5 A s3 | 1 | 57.66 | 6 | 88 | 0 | no
V1 | a | 1 | 95.62 | 6 | 32 | 0 | no
V1 | b | 1 | 57.66 | 6 | 88 | 0 | no
V2 | a | 1 | 96.35 | 22 | 134 | 0 | no
V2 | b | 1 | 57.66 | 6 | 88 | 0 | no
All 6 rows: 9 of 9 identical text, in-process and fresh, th1 and th4. Run time 21:12:07 to 21:18:47 (t1_start/t1_end.txt).
V0 does loop: 157 words against a 137-word reference and WER 123.36. My per-segment detector missed it; the whole-text check caught it. V0 fails.

## Choice: V1 (fewest changes among variants that pass both cells with 0 loops; V2 also passes).

## T2 shift spread, V1, run3 snr5 raw micA, th4 (t2_fresh.jsonl, t2_inproc.jsonl)
Shifts 0..7 WER: 60.58, 41.61, 59.85, 57.66, 56.93, 45.99, 59.85, 58.39. Mean 55.11, sample sd 7.18. Loops 0.
In-process 8-shift run: same 8 WER and same 8 text hashes as the fresh-process run (8 of 8 exact match). Wall 21:20:16 to 21:21:30.

## T3 run4 shift 0, V1, fresh process per file, transcribed from 6 s (t3.jsonl)
take | micA | micB
spL_nzR_0 | 66.42 | 85.40
spR_nzL_0 | 40.15 | 67.88
both_0 | 72.26 | 92.70
spL_nzR_m5 | 88.32 | 118.25
spR_nzL_m5 | 77.37 | 108.03
both_10_g31 | 27.74 | 32.85
both_10_g41 | 27.01 | 32.85
both_10_g51 | 29.20 | 35.77
Means over the 8 takes: micA 53.6, micB 71.7 (B minus A = +18.1). micA beats micB in 8 of 8 takes. The placement gap survives. Run 21:21:30 to 21:23:16.
Comparison to "O1's 38.2 vs 68.6": I could not match those two figures to micA/micB means. In O2-REPORT.md, 38.2 is raw micA run4 spR_nzL_0 and 68.6 is raw micA run4 both_0, both micA. I report the 8-take means above and the per-take table instead.

## T4 (t4.jsonl): scorer3 `det 1 2` (run3 snr0 DFN micB shift 2, th1), 10 fresh processes
10 of 10 gave WER 96.35, text sha e13bef06170b. Divergences: 0. R3's 111.68 did not recur. Run ended 21:27:01 (t4_end.txt).

## Scripts sha256
scorer4.py     3f3a7b2cbdb2430e1698a64e097b809ce83a7c572399398a22ee257a5b2af2b6
scorer4_t1.py  89e90acaaa7ea92c8be9aff61cafaa37700e7c7b0ed8b6f09c678c77e571c091 (version used for t1.jsonl)
run_t1.sh      6c048c0465a9bd968237812eb69d871d51657a09902cb559a09e9a4b11c68e45
run_rest.sh    9b15241d877e236a78b461157d8d1ad7d6fc791b79f661195805b17cc51a5221

## Recommended variant: V1 (temperature=0.0, no_repeat_ngram_size=3).

## Flags
1. V1 on cell a outputs only 32 words (WER 95.62 comes from deletions). It does not loop but drops most of the speech there. V2 keeps 134 words in that cell (WER 96.35). Neither is "right"; both are near-100% on an unusable cell.
2. V1 values differ from the old scorers (e.g. shift 0 of snr5 micA 60.58 vs 59.85; T2 mean 55.1 vs O3's 47.0 / R3's 45.4). Do not compare V1 numbers with O1-O3 numbers.
3. T3 micB spL_nzR_m5 (118.25) and spR_nzL_m5 (108.03) are above 100 with whole-text loops flagged 0. I did not read those transcripts, so the cause is unknown.
4. T1 loop counts for the main run came from the per-segment detector only; the whole-text check ran on 6 of the 54 T1 runs (one per variant and cell, th4).
5. In T4, R3's 111.68 did not reproduce, so I cannot say what caused it. Not run in the same call order as R3.
No SQL or schema assumptions. No manual steps. Subagents: none.
