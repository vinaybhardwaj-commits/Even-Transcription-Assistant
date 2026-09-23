# ETA — encounter clock E-1/E-2 (flag off). REFUTER VERDICT. 22 Sep 2026

`vinay/encounter-clock` **@ `07bd5b9`** (builder split-speaker), base `248c2ae`. `lib/encounter-clock/{flag,gate,probe}.ts` plus 2 test files; no route, migration or caller. I did not review the untracked `smooth.ts` in the pane's worktree; it is not in the commit. My own detached worktree: `/tmp/refute-clk`. Production: read-only, counts only.

## PASS — with one of the three extra verdicts to change before anything calls the gate

The modules are correct for what they claim. The flag is off and nothing calls them. The findings below matter at wiring time, not now.

### The three extra verdicts Fable accepted provisionally
- **Dead mic → unjudged: SAFE.** A lost input says nothing about the room. Failing toward a digital noise gate is harmless too: a live room with more than half exact-zero frames reads as dead, which is unjudged, never silence.
- **Loud room + no transcript → unjudged: SAFE.** This is "no transcript COVERS the probe", so it is missing evidence. (Loud room + covered transcript below 0.15 is `non_speech/no_text`: the recogniser read the probe and found nothing. That is also acceptable.)
- **Quiet room + text → non_speech (`text_on_quiet_audio`): UNSAFE as specified.** It is the one place where the two halves **disagree** and the gate still picks silence.
  - The hallucination argument is weak here: text only reaches 0.15 unique chars/s after repeated lines are counted once, so what is left is not the looping signature.
  - "Quiet" means under 5% of 20 ms frames at or above −48 dBFS (the default floor): 9 s of 180. A soft-spoken or far-field consult can fall under that.
  - **Recommend `unjudged` (reason `halves_disagree`)** until a bench of frame-path probes shows how often quiet-with-text is real speech. Mutation C18 shows the reason code is pinned, so the change is small and visible.

### FINDING 1 (medium, plan) — the level-log half is inert on today's data
Production `bench_level_sample`: **0 of 1,888** rows have `avg`; only `peak` and `zero_ratio` are populated (`source = command_poll`, one sample per ~2.1 s). `energyHalf` reads `avg`, so the level path can only return `dead_mic` or `missing`. The scheduler's `skip_quiet` pre-selection never fires, and **every probe will be fetched and decoded**. `bench_chunk.avg_level` is almost empty too (11 of 11,283 in 14 days). The code fails safely (missing → extract). But the plan's hope that the level log replaces decoding needs the recorder to report `avg`, or a peak-based rule measured against frames.

### FINDING 2 (medium-low) — overlapping chunks double the audio, and coverage hides it
Consecutive chunks that overlap in time: **9 of 11,140** pairs in 14 days, **8 by more than 100 ms, the largest 82.6 s**. `mapProbeToChunks` takes a piece from each chunk, so the overlap's audio appears twice in the probe PCM. `coverage = min(1, mapped / expected)` then reads 1. `total_samples > expected_samples` shows it, but nothing acts on it. Fix: when pieces overlap on the clock, take the overlap from one chunk only (or mark the probe), and test it. Gaps are handled honestly: 173 gaps over 100 ms lower coverage as designed.

### What holds
- Offsets are computed from each chunk's own start (C12 killed).
- The little-endian PCM hash is pinned (C15 killed).
- Short decodes lower coverage; nothing is padded.
- `verifyContract` catches a changed chunk hash and a changed PCM hash (C14 killed).
- A probe with no level coverage is always extracted (C17 killed).
- Transcript coverage must span the whole probe (C5 killed).
- Repeated lines count once (C6 killed), and spans are weighted by overlap (C7 killed).
- Missing energy and missing transcript are never silence (C2, C3, C4 killed).

## Gate
Targeted vitest (gate and probe): **37 passed**. Mutations **16 of 18** killed.
- C13 (verify drops the sample-range check) survives: redundant, since a moved range also changes the PCM hash. Low.
- C16 (no clamp on a short decode) is equivalent: `subarray` clamps by itself.

## Jev — condensed pseudocode diff, none of my findings in its context
Scores 4.4–6.6, low confidence (0.2 on correctness).
- **correctness 4.4**, "requested behaviour missing or incomplete" — **consistent** with Finding 1 (the level pre-selector exists but cannot act on production data). It was not told about `avg` being null, so this is not proof.
- **performance 5.5**, "I/O repeated" — **confirmed, low**: with a 60 s hop and 180 s probes, each chunk is fetched and decoded by about 3 probes. A per-day chunk cache belongs in the caller.
- **readability 5.0, documentation 4.8, consistency 4.8** — **discounted**: I sent pseudocode without the files' extensive comments.
