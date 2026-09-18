# ETA — W3: WHISPER NOISE FLOOR — REPORT
**14 Sep 2026 · 3 identical passes, 15:12–15:16 IST · whisper arm only · no config, plist, router or repo change · no git**

**Pooled spread (max − min) over 3 passes: chars 1,122 (19,938 / 18,816 / 19,784) · M5-A repeat_ratio 0.065 (0.404 / 0.339 / 0.360) · M4 collapse fraction 0.068 (0.436 / 0.368 / 0.389) · A-redundant chars 1,680 (8,063 / 6,383 / 7,113).**
**Pooled variance (sample, n−1): chars 369,937 (SD 608) · repeat_ratio 0.00111 (SD 0.033) · M4 fraction 0.00122 (SD 0.035).**

**Setup.** M7's request each time: `POST localhost:8081/inference`, `response_format=verbose_json`, `temperature=0.0`, nothing else. Same ten windows, same order; 30 of 30 returned 200, one whisper POST each. whisper-server PID 1813 and the plist (sha256 `5c0b3fd3…`) were the same before and after.

| Win | speech | same text ×3 | chars p1 / p2 / p3 (spread) | repeat_ratio A (spread) | M4 fraction (spread) |
|---|---|---|---|---|---|
| W01 | 0.006 | yes | 14 / 14 / 14 (0) | 0.000 / 0.000 / 0.000 (0.000) | 0.000 / 0.000 / 0.000 (0.000) |
| W02 | 0.047 | yes | 259 / 259 / 259 (0) | 0.413 / 0.413 / 0.413 (0.000) | 0.571 / 0.571 / 0.571 (0.000) |
| W03 | 0.136 | yes | 743 / 743 / 743 (0) | 0.031 / 0.031 / 0.031 (0.000) | 0.062 / 0.062 / 0.062 (0.000) |
| W04 | 0.208 | **no** | 854 / 948 / 741 (207) | 0.331 / 0.623 / 0.000 (0.623) | 0.456 / 0.689 / 0.109 (0.580) |
| W05 | 0.312 | **no** | 1512 / 1379 / 1700 (321) | 0.236 / 0.165 / 0.159 (0.077) | 0.350 / 0.263 / 0.270 (0.087) |
| W06 | 0.338 | yes | 2049 / 2049 / 2049 (0) | 0.626 / 0.626 / 0.626 (0.000) | 0.664 / 0.664 / 0.664 (0.000) |
| W07 | 0.364 | yes | 3436 / 3436 / 3436 (0) | 0.962 / 0.962 / 0.962 (0.000) | 0.988 / 0.988 / 0.988 (0.000) |
| W08 | 0.512 | **no** | 3651 / 2448 / 3412 (1203) | 0.741 / 0.346 / 0.623 (0.395) | 0.772 / 0.387 / 0.645 (0.386) |
| W09 | 0.627 | **no** | 3670 / 3790 / 3680 (120) | 0.000 / 0.000 / 0.000 (0.000) | 0.002 / 0.002 / 0.002 (0.000) |
| W10 | 0.726 | yes | 3750 / 3750 / 3750 (0) | 0.000 / 0.000 / 0.000 (0.000) | 0.000 / 0.000 / 0.000 (0.000) |

**Whisper is not deterministic at `temperature=0.0` on 4 of 10 windows, and they are exactly W04, W05, W08 and W09.** The other six returned identical text three times. M7's 13:09 baseline falls inside the three-pass range for every pooled metric, and per window for chars in all windows except W09 (3,619, below the range).

## The questions, answered with the numbers
**W1 arm 1, per-window character changes (whisper-alone): inside the noise floor.**
- **W04, W05, W08:** +110, −46, +999 against spreads of 207, 321 and 1,203, so all three are inside.
- **W09:** +194 against a three-pass spread of 120. But M7's own baseline (3,619) is also outside those three passes, so across all four default runs W09 spans 3,619–3,790 (171). Arm 1's 3,813 is 23 above the highest default value observed. That is not established as an effect.
- **The six deterministic windows did not change under `auto` at all.** All of arm 1's movement sits in the four noisy windows.
- **Pooled:** arm 1's 0.433 is 0.029 above the highest default pass (0.404), which is less than one pooled spread (0.065). **Not distinguishable from noise.**

**W1 arm 2, "three segments moved": not calibrated by this round.** Those flips are route per-segment decisions on 30 s slices, which are different whisper requests from these 300 s calls. This round measured whisper-alone variance only, and route's run-to-run variance is still unmeasured. Whisper-alone nondeterminism in 4 of 10 windows means the flips **cannot be assumed** to be effects either.

**W2, redundancy drop: larger than the noise floor.**
- **Redundant chars:** 6,987 → 1,687 is a drop of **5,300**, which is **3.2× the pooled spread of 1,680**. After-value 1,687 is 4,696 below the lowest default pass (6,383).
- **repeat_ratio:** the drop of **0.263** is **4.0× the pooled spread of 0.065**; 0.107 sits 0.232 below the lowest pass (0.339).
- **Chars:** the drop of 3,135 is 2.8× the pooled spread of 1,122.

**Correction to W1's variance flag.** W3's three passes gave W03 identical text every time, so **W2's −4 chars on W03 was not noise**. `max_context` can affect any window decoded in more than one 30 s pass, so the earlier phrase "a setting that could not have touched it" was wrong.

**Flags.** (1) **Three passes is a thin sample.** The true spread is probably wider, as W09's baseline falling outside the range shows. (2) **Unverified cause of the variance.** One plausible mechanism is temperature fallback (entropy threshold 2.40, then sampling at t > 0) firing in some windows; not checked. (3) **Files:** `scratch/W3-MEASURE-14-SEP-2026.py.txt` (M7 metrics unchanged; asserts M7's baseline) and `scratch/W3-MEASURE-OUT-14-SEP-2026.json` (numbers only, checked free of transcript text). Raw outputs are private, in the session scratchpad. Sample limits as M7: one room, one day, 300 s windows.
