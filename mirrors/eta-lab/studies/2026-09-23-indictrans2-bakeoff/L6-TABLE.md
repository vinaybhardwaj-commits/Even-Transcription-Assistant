# L6 translation bake-off - comparison table (metrics only, no patient text)

| Model | n | errors | numbers kept | dose kept | empty/loop | p50 | p95 | blind judge vs Gemini |
|---|---|---|---|---|---|---|---|---|
| Gemini 3.8 Flash (baseline) | 43 | 1 | 70.9% | 100.0% | 25.6% | 17.2s | 41.0s | — (baseline) |
| Sarvam-Translate 4B (T4) | 43 | 2 | 66.2% | 100.0% | 32.6% | 90.9s | 140.1s | Gemini 39 / tie 1 / model 0 (n=40, unparsed 0) |
| TranslateGemma 4B (M4 MPS, bf16) | 43 | 0 | 75.7% | 83.3% | 34.9% | 14.5s | 171.1s | Gemini 41 / tie 1 / model 0 (n=42, unparsed 0) |
| TranslateGemma 12B (L4, 4-bit) | 43 | 0 | 75.0% | 83.3% | 23.3% | 71.1s | 219.3s | Gemini 40 / tie 2 / model 0 (n=42, unparsed 0) |
| TranslateGemma 4B (T4, earlier run; history only, unreliable - see notes) | 43 | 7 | 51.4% | 66.7% | 44.2% | 99.0s | 180.1s | — |

## Timing of the same 8 windows (12B 4-bit, concurrency 1, no other GPU job)
| setup | total s (8 windows) | timeouts | windows with EMPTY output |
|---|---|---|---|
| L4, bf16 compute | 269 | 0 | 0 |
| T4, bf16 compute | >= 3890 | 4 (900 s cap) | 8 of 8 |
| T4, fp16 compute | >= 2606 | 4 (600 s cap) | 8 of 8 |

**The T4 12B 4-bit setup returned empty text for every window in both compute dtypes** (the ones that did not time out finished in ~50-72 s with zero characters). Those timings measure a broken run, not translation speed, so there is no valid T4 number for 12B. Cause not established (bitsandbytes 4-bit on Turing sm_75 with torch 2.14/cu126 is the suspect; not isolated).

## Time and cost per 1,000 turns
Serving is unbatched (one sentence at a time, batch 1), so these are upper bounds on local cost. The L4 mean is over the full 43-window run, which merges one concurrency-3 pass with two concurrency-1 retry passes (some queueing included). Rs and USD are not converted.
| setup | mean s/turn | hours per 1k turns | cost per 1k turns |
|---|---|---|---|
| TranslateGemma 12B 4-bit on gcp-l4 (US$0.92/h) | 79.8 | 22.2 | US$20.4 |
| same, on eta-lab-t4 (Rs 30/h) | no valid measurement (empty output, see above) | — | — |
| TranslateGemma 4B on ehrc-audiometry M4 MPS (owned machine) | 49.0 | 13.6 | ~0 marginal |
| Gemini 3.8 Flash via OpenRouter (translation calls only, measured) | ~17 median | n/a | ~US$11.7 |

## Caveats
- Same 43 real room windows (kn19/ta14/hi6/ml2/gu1/te1; 9 rooms; 22-23 Sep). Numbers/dose = lexicon + regex; empty/loop = a 3-gram repeated 3x or empty. These are proxies: they rated IndicTrans2 well and V's native-speaker read still rejected it.
- Blind judge: google/gemini-3.1-pro-preview via OpenRouter (ZDR), both orders per pair, candidate = A, Gemini = B. The first attempt capped output at 500 tokens and 43% came back unparsed; it now uses 6000 and every pair parsed. Judge spend this run about US$2.95. One window has no stored Gemini output and 2 Sarvam windows had no output, so n is 40-42 rather than 43.
- 12B is 4-bit (nf4), not 8-bit: bitsandbytes LLM.int8() generation on the L4 did not finish a two-sentence request in 60 s, and bf16 does not fit 24 GB.
- Earlier T4 results (the 4B history row with 7 errors and heavy empty/loop, and a 12B attempt that timed out on 34 of 35 turns) were first put down to diar-lab contention. That explanation is not supported: the T4 12B setup returns empty text even with the GPU otherwise idle. Treat all T4 TranslateGemma numbers as unreliable.
- The 4B (M4 MPS) full-run text was not saved, so its 43 outputs were regenerated (greedy, deterministic) for the judge.
