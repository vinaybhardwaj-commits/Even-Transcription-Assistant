# VAD v3 — pre-registration for the TEST pass (written 24 Sep 00:15 IST, before any TEST scoring)

Responds to `METHOD-REVIEW-eta-refuter-2.md` (M1–M8). Read the honesty note first.

## Honesty note — what is and is not held out
- The 20 bake windows are **DEV forever** (M6). They chose Silero 0.15/1200/500, Arm B's constants
  (1.10 x p3 floor, 0.5 s hangover, 0.3 s blip), the WebRTC aggressiveness, and the preprocessing chain.
- The 58-window set (`datasets/vad-v3-test-set.json`, K1-fixed) is **also DEV**, not TEST: I looked at its
  per-arm results and picked the ensemble members and the pad length (1.0 s / 2.0 s) with sight of them.
  Every "passes on 58" figure in REPORT.md is therefore exploratory, not a pass verdict.
- One thing is genuinely out-of-sample on the 58-window set: arms whose constants were fixed on bake20
  before the 58 set existed and were not changed afterwards (Arm B, Silero base, S_all3 preprocessing,
  production whisper.cpp defaults). Their 58-window numbers are a fair generalisation check.
- No room-day split was made (M7). It cannot be made honestly now because every current window has been seen.
  **TEST = windows that receive a pyannote.ai label after this commit, from room-days not present in DEV.**
  herdr-kit says more accrue overnight. If fewer than ~100 arrive, "every window" cannot be claimed (M1 note).

## Frozen candidates (no further tuning; `score_frozen.py FROZEN`)
1. `B` — VAD-v2 Arm B, energy-only (unchanged constants). Reference / safe baseline.
2. `U(S_all3,B)` — union of Silero-on-(highpass80 -> denoise -> loudnorm) and Arm B.
3. `U(S_all3,W0)+pad1.0s` — union of that Silero arm and WebRTC agg 0, each kept span extended 1.0 s per side.
4. `U(S_all3,W0)+pad2.0s` — same with 2.0 s padding. Primary candidate (0 dropped segments on DEV).
Reference-only (expected to fail): `S_all3`, `W0`. Production whisper.cpp gate is scored separately.
Denoiser is `noisereduce` spectral gating, a proxy; a neural denoiser is untested and out of scope for TEST.
No per-room configs (M8): too few windows per room; global configs only.

## Metrics and bars (M1–M3), applied identically to every arm
- **M1 regime:** a window counts toward the % bar only if teacher speech >= 60 s; otherwise the bar is an
  absolute <= 2 s of teacher speech cut. Report the count in each regime.
- **% bar:** <= 2% cut on every %-regime window and p95 <= 1%, **using the +-0.25 s collar figure**; the
  uncollared figure is reported beside it.
- **M2:** count of teacher segments >= 0.3 s that are >= 80% cut. Bar: 0 in every window (a stated small count
  is allowed only if the segments are then listened to).
- **Objective:** minimise audio sent subject to the above on TEST; report sent % and the ₹/night saving at
  the TEST sent %, never at the DEV figure.
- **Truth:** pyannote.ai speech = any human speech in the room. Non-clinical speech is not removed from the
  loss figure unless V's listening pack says so, and any relabelling applies to all arms identically.
- **Circularity flag:** VAD-v2 Arm C (pyannote seg-3.0) shares lineage with the teacher; not used as evidence.

## Still to do before a sign-off is possible
- M4: audit speech that pyannote.ai MISSED inside the frozen candidates' cuts (done 24 Sep 00:30, see REPORT.md: 2/40 cut clips speech-like; the two clips are in the pack).
- M5: blinded, random, stratified listening pack with controls and a three-way answer (built 24 Sep 00:30, 33 clips (31 + 2 dropped-segment clips), reshuffled and renumbered 24 Sep with seed 20260925, local only; answers not yet collected; the earlier 15-clip pack was biased and is superseded).
- One TEST scoring pass, run by eta-refuter-2 on the TEST manifest; no re-tune afterwards.

## Amendment, 24 Sep 01:20 IST (after eta-refuter-2's review, before any TEST scoring; TEST is unburned)
1. **TEST is blocked**: 1 eligible labelled window on 1 room-day (refuter's read-only count). ~100 are needed. No TEST scoring will be run below that.
2. **DEV exclusion by real id**: `datasets/vad-v3-dev-roomdays.json` lists the 27 DEV room-days (bake20's 15 come from `bench_window.id`, because bake20 stems do not match
   the label table's window ids). TEST windows must come from room-days not in that file.
3. **Alignment gate**: every TEST window must pass an audio-vs-teacher alignment check (|lag| <= 0.3 s, whole window and each half; `align_check.py` plus the digital-silence
   padded-gap check) BEFORE scoring. A failing window is re-fetched (gaps closed, as `bench-join` does) or excluded, and it is reported. It is never scored misaligned.
4. **Fifth frozen candidate added**: `U(S_all3,W0)` with no padding. Reason: the alignment sensitivity analysis showed the padded variants' extra margin was absorbing alignment
   artefacts. This addition is made with DEV in sight (it was a reference row already in `score_frozen.py`), so DEV cannot rank the five; TEST is the arbiter. No parameters change.
5. **The (b)/(c) production-gate transcript comparison is a smoke test only** (English-forced decoding, 12 non-random windows, no reference); the drop-versus-retune argument rests on (a).
6. **M2 rule on TEST (settles the refuter's nit):** the bar is **0 dropped segments** (>= 0.3 s and >= 80 % cut) in every window. A config with any dropped segment does **not** pass M2 on TEST.
   Each dropped segment is still put in a blinded listening pack afterwards; if V judges every one of a config's dropped segments "not clinical speech" the config is reported as "M2 pass after listening",
   shown separately from a plain pass, and the listening cannot change the plain result. DEV has 1 (clean part of the 58 set) + 1 (bake20) such 0.3-0.4 s segments for the unpadded union; both are in V's pack (ids withheld; the pack was renumbered and reshuffled on 24 Sep with seed 20260925).
7. **Label consistency (the other nit):** `score_frozen.py` no longer calls the unpadded union "REF-ONLY"; it is a candidate. `S_all3` and `W0` alone stay reference-only (expected to fail).
