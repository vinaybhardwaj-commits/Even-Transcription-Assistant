# Whisper parity, c3 CPU twin (lab-mover, 24 Sep, ruling 4 addendum to PARITY-WHISPER.md)

Numbers only; no transcript text. Ruling 15 forbids lab load on the Mini from 08:00, so this run is **twins only** (box, gcp-l4, c3, each through its own shim, production-shaped request). split-speaker's 58-window whole-window run (Mini, box, gcp-l4) is in `PARITY-WHISPER.md`; c3 is not reachable from that harness, so this fills the gap. Harness: `whisper_parity.py`; raw rows: `whisper_parity_setB_twins.json`, `whisper_parity_setC_twins.json`.
Coverage = share of pyannote.ai-labelled speech seconds covered by returned segments. WER is UNMEASURED (no reference transcripts).

## Set C: 12 slices x 300 s (one per bench session, best-speech span), one pass, 36 requests, 0 errors
| backend | mean coverage | words | off-speech s (mean) | wall per 300 s slice | speed |
|---|---:|---:|---:|---:|---:|
| box (T4) | 0.830 | 4,386 | 65.9 | 20.4 s | 14.7x |
| gcp-l4 (L4) | 0.845 | 4,350 | 67.9 | 11.8 s | 25.4x |
| **c3 (CPU, -t 8, Nice 10)** | **0.828** | 4,468 | 64.6 | 62.4 s | **4.8x** |

c3 minus box: mean -0.002 (worse by more than 0.16 on 1 of 12 slices, better on 0). c3 minus gcp-l4: mean -0.017 (worse on 3, better on 1). The per-slice spread is large where the slice holds little labelled speech (e.g. a slice with 4 s of speech: gcp-l4 0.52, box and c3 1.00).

## Set B: 5 clips x 120 s x 2 passes (run-to-run), twins only
Mean coverage box 0.72, c3 0.75, gcp-l4 0.78. Each backend's own run-to-run coverage difference: mean 0.04 (box), 0.10 (c3), 0.10 (gcp-l4), max 0.18 / 0.32 / 0.44. The coverage gaps between backends (+0.05 to +0.06) are inside those self-spreads. One c3 request (clip 1, pass 1) is excluded: it queued behind my own abandoned 900 s decode and hit the shim's 120 s limit.

## Reading against ruling 4(c) ("no worse than the Mini by more than the Mini's own run-to-run variation")
- c3 is statistically indistinguishable from box and gcp-l4 on labelled-speech coverage (n = 12 slices + 5 clips, small), and those two twins passed against the Mini on 58 whole windows (split-speaker). So c3 passes by transitivity, **but a direct c3-vs-Mini comparison is UNMEASURED** (ruling 15). It can be run after 20:30 if wanted.
- **c3 limits, unrelated to quality:** 4.8x realtime means a 90 s client timeout finishes only about 7 minutes of audio (4.8 x 90 s), and a whole 900 s window fails at 123 s (curl status 000: the shim drops the connection after its 120 s upstream timeout while whisper-server keeps decoding the abandoned request and blocks the next one). c3 whisper is fit only as a last-resort fallback for short requests.
