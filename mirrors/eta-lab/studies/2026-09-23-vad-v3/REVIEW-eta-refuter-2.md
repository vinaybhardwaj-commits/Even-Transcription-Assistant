# VAD v3 — Refuter review of the evidence (eta-refuter-2, 24 Sep 2026, eta-lab b8108e1)

Scope: REPORT.md, PREREGISTRATION.md, score_frozen.py, run_ensembles.py, build_audit_and_pack.py, with the data on
the E2E box. Not built by this session. Counts and seconds only; no audio or text left the box.

**VERDICT: NOT YET SIGNABLE. TEST is BLOCKED (1 eligible window), and 2–3 DEV windows are misaligned against
the teacher by ~5.6 s, which is MY K2 advice's fault. The method is otherwise sound, and the honesty note is correct.**

## 1. TEST pass: BLOCKED, not run
- DB (read-only, counts): pyannoteai labels created after 6443994 (24 Sep 00:00:48 IST) on room-days not in DEV:
  **1 window, 1 room-day** (newest 23 Sep 18:38Z). The preregistration needs ~100. Scoring 1 window would burn
  TEST for nothing, so I did not run it. It is ready to run when the count arrives.
- **Fix the DEV exclusion first:** only 58 of the 78 DEV file stems match a `diarize_window_label.window_id`.
  The 20 bake20 stems don't, so bake20's room-days are NOT in the exclusion set as built from file names. The TEST
  manifest must exclude bake20's room-days by their real ids.

## 2. Alignment: an independent check (NEW), and a correction to my own K2 advice
Method: per window, the lag that maximises the correlation between the audio's log-energy envelope (100 ms) and
the teacher's speech mask, over ±10 s. 0 means audio and labels line up.
- bake20: **20/20 within ±0.2 s**. 58 set: **52/56 scored within ±0.2 s** (45 exactly 0; 2 skipped for <5 s of speech).
  The K1 fix (fbf6a96) works: all 58 durations are 899.92–899.96 s.
- **But both `nrqthr5b` windows have ONE padded silence run (5.5 s and 5.4 s), and after it the audio sits
  +5.8 s / +5.6 s LATE against the labels** (first half at 0, second half at +5.8/+5.6). `lib/bench-join.ts:221`
  says the production clip's trim is expressed "against the JOINED stream, which has no gaps in it": **the teacher
  labelled a gap-CLOSED clip.** Padding gaps with silence, which is what I told herdr-kit to do in K2, puts
  post-gap audio late. **My K2 fix was wrong.** Correct rule: reproduce bench-join, i.e. close the gaps and
  assert duration = covered seconds, not the window length. Best: fetch the exact `clip_r2_key` object the
  teacher labelled (that needs invoke scope or R2 read).
- `33g2chqe`: three ~5.5 s digital-silence runs; the first half is aligned, the second half is ambiguous (−2.9 s,
  corr 0.21). Treat it as suspect. `9j4z2ze3`: lag −1.3 s on a weak correlation (0.19; at 0 s it is 0.08), noisy, unresolved.
- **Consequence:** the primary candidate's only residual failures on the unpadded union were `nrqthr5b` (2/3)
  and `9j4z2ze3` (1/3). REPORT.md says pad 1.0 s "clears both". So the pad length was chosen to absorb a
  misalignment artefact. The candidates stay frozen (no re-tune). But pad1.0's "1 dropped segment" and any
  failure on these windows are not evidence about the VAD.
- **TEST gate:** every TEST window must pass this alignment check (|lag| ≤ 0.3 s) BEFORE scoring. A window that
  fails is re-fetched or excluded, and it is REPORTED. It is never scored misaligned.

## 3. Checks that pass
- score_frozen.py implements M1–M3 as written: the collar shrinks teacher segments by 0.25 s a side; M2 counts
  unmerged segments ≥0.3 s with ≥80% cut; labels are matched by exact window id (the prefix bug 53c2b3a is
  gone here); sent % = Σkept / Σreal duration.
- **Arm B's 99.0% vs 97% is RESOLVED:** the bake20 cache gives a mean of 1740 s sent, the same figure VAD-v2
  reported as "1740/1800 s (97%)". But bake20 durations are 1011–1800 s, not all 1800. v2 divided by an
  assumed 1800 s (the same class as the divisor bug fixed tonight). **99.0% is correct.**
- The honesty note is accurate: bake20 and the 58 set are DEV; fixed-constant arms are fair out-of-sample checks
  on the 58 set.

## 4. Reading the results
- **Arm B "passes" because it sends everything.** Energy-active covers 96–99% of every window, so the bar has no
  power against "keep it all". A pass by any arm means nothing without its sent %. The real finding is the
  report's own: safe trimming is ~4–8%, far from the 72% oracle. The pyannote.ai saving lever is small.
- **The production-gate speech loss (19.6% / 34.4%) is the strongest result here.** It needs no tuning, it is
  out-of-sample on the 58 set, and it agrees with split-speaker's independent 20.3%.
- **The (b)/(c) transcript comparison can't carry the drop-or-retune argument.** It used 12 NON-random windows,
  no WER, and `language` left at whisper-cli's default **en** on Hindi/Kannada speech. English-forced decoding
  makes word counts incomparable. Keep it as a smoke test only; the decision should rest on (a). A fair (b)
  needs random windows, the live server's real language setting, and a reference sample.
- M4 (2/40 speech-like clips): fine as a reason to listen, not a rate, as the report says.
- M5 pack (checked, not listened to): seed 20260924, 31 clips = 16 disputed (round-robin over windows, random
  offsets), 2 m4-speechlike (all that exist; deliberate), 3 m4-random, 5 positive and 5 negative controls. Shuffled,
  opaque ids c01–c31. The answer key sits OUTSIDE `clips/`. listen_v2.html contains no condition words (its only
  hit is the `<audio controls>` attribute). One caveat: **c17 is a disputed span from `9j4z2ze3`**, the window
  with unresolved alignment, so its "teacher says speech" condition is itself uncertain. Score c17 separately.

## Addendum — 0c7a922 (lab-mover applied the review)
- **Sensitivity re-score reproduced byte-for-byte:** my own run of score_frozen.py with `alignment_excluded_58.json`
  (54 windows) is identical to the committed `score_frozen_58_sensitivity_excl4.json`. The unpadded
  U(S_all3,W0): 0/39 %-bar fails, worst collared 0.60%, 0/15 absolute fails, sent 83.4%, **1 dropped segment in 1 window**.
- The preregistration was amended (00:19:50 IST) before any TEST scoring (none exists). DEV list: 27 room-days
  by real id, 78 windows (bake20 15 + 58-set 19, with overlap). Correct.
- Two things to settle BEFORE TEST, so the TEST table can't be read two ways:
  1. **The label conflict:** PREREGISTRATION.md item 4 calls the unpadded union a "fifth frozen candidate",
     but score_frozen.py names it `REF-ONLY U(S_all3,W0) no pad`. Pick one. If it's a candidate, drop "REF-ONLY".
  2. **M2 for that candidate:** the preregistered bar is 0 dropped segments, or a small stated count that is
     then LISTENED to. It drops 1 on DEV. State now which rule applies on TEST, and put that segment in V's pack.
- With those two fixed, the method has my sign-off. The RESULT still needs the single TEST pass (≥ ~100
  alignment-checked windows), which remains blocked at 1.

## Sign-off — METHOD (b97dd9f, 24 Sep 00:22 IST)
- Both nits are settled: score_frozen.py has no "REF-ONLY" (the unpadded union is a candidate; S_all3 and W0 alone
  are reference-only). Preregistration item 6 sets M2 on TEST = 0 dropped segments, and listening only adds a
  separate label. Both commits come before any TEST scoring.
- **The METHOD is SIGNED OFF.** The RESULT is not: it awaits the single TEST pass that I run on ≥ ~100
  alignment-checked windows from room-days outside `datasets/vad-v3-dev-roomdays.json`. No re-tune after it.
- Non-blocking pack note: c32/c33 were appended as the LAST two ids, and both are exactly 6.0 s long (most
  clips are 10 s). Position and length together mark them. V hasn't answered yet, so re-shuffle and
  renumber all 33 now with a new fixed seed (key outside `clips/`, as before). It costs nothing and restores the blinding.
