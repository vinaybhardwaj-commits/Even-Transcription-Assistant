# 337e on HF Jobs (r386 S4): smoke parity, pre-registered BEFORE the HF job runs (25 Sep, box clock ~12:15)
Data: one PUBLIC clip, no patient data: first 600 s of the first AMI ihm test meeting (diarizers-community/ami, CC-BY), 4 real speakers, 171 reference segments.
Reference run (box, Tesla T4, torch 2.14.0+cu126, NeMo Speech cf724ac): 425 turns, 4 speakers found (`box_smoke.jsonl`, box only).
Candidate: the same `hf_consume.py` and the exact 167-package freeze of the box venv on an HF Job, flavor a10g-large.
PASS (all three): (1) same number of speakers as the box run; (2) frame agreement between the two runs' turn maps on a 10 ms grid over the 600 s, after the best one-to-one speaker relabelling, >= 0.98 (arrival order should already match); (3) the job wrote the file and exited 0.
If (2) fails between 0.90 and 0.98 I look at where they differ (fp/kernel differences at turn edges) and report it, and do NOT use the HF run for the full 337e without Fable's word. Below 0.90: FAIL, 337e goes back to the box T4 / the L4.
Also reported (not gated): seconds per audio-hour on the A10G (incl. and excl. model load), cost.

## Result of the public smoke (a10g-large job vrbeven/6ab6170f6b030d633f690785, 25 Sep ~12:20)
PASS on all three: 4 speakers vs 4; 425 turns vs 425; frame agreement 1.0000 (10 ms grid, best relabelling); job exit 0. Wall 98 s total, 11 s of diarization for 600 s of audio (includes the first-step kernel warm-up). torch 2.14.0+cu126 on NVIDIA A10G (driver 580).

## Step 2, pre-registered before it runs: 5 REAL windows (patient data, private bucket vrbeven/diarlab-337e, r382) already done on the box T4 (`full_nemo_t4.jsonl`, wav decoded by ffmpeg from the same FLAC)
PASS (per window, all 5): same speaker count and frame agreement >= 0.98 (10 ms grid, best relabelling) between the HF turns and the T4 turns. Any window below 0.98: I report the numbers and stop; the full run on HF then needs Fable's word. Then the full run starts (batches of 420).

## Step 2 result and extension (pre-registered before the extension runs)
Step 2 (5 real windows, job vrbeven/6ab618656b030d633f6907b2, 1.25 audio-h in 20 s on A10G = ~16 s per audio-h incl. warm-up): 5/5 PASS, but 4 of the 5 windows have no speech (0 speakers on both engines), so that is weak evidence. Extension: 10 more real windows that HAVE speech (>= 3 speakers in the box T4 result, from `ref_nemo.jsonl`), same criteria (same speaker count, frame agreement >= 0.98 on a 10 ms grid per window). Any failure: stop and report; the full run then waits for Fable.

## Extension result (job vrbeven/6ab6191b52d0dbd7f1d8e91a, 10 real speech-bearing windows, 2.50 audio-h in 31 s on A10G = ~12 s per audio-h)
10/10 PASS: identical speaker counts (3-6) and frame agreement 1.0000 in every window vs the box T4 turns. Full run started 12:20 box clock: 3,558 windows in 9 batches of 420, one a10g-large job per batch, private bucket vrbeven/diarlab-337e; results are collected, verified by window id, then the bucket is deleted.
