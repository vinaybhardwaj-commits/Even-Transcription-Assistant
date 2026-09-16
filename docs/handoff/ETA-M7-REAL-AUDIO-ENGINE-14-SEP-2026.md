# ETA — M7: ROUTE vs WHISPER ON REAL ROOM AUDIO — REPORT
**14 Sep 2026 · Builder · Mini run 13:08:52–13:21:03 IST · no transcript text anywhere · no git, no commit**

1. **Speech ratio.** The ten real 300 s windows range from **0.006 to 0.726** (silero-VAD).
2. **IndicConformer.** It won **1 of 65** route segments across the 9 windows route completed. SraVaani won 31 and whisper 33. Route **failed with HTTP 500 on W03**.
3. **Repeat rate under M5 rule A**, pooled over the 9 matched windows:
   - **whisper's repeat_ratio: 0.384**, with loops in 6 of 9 windows (0.370 and 7 of 10 counting W03);
   - **route's: 0.018**, one loop in 1 of 9 windows.

## Conditions of this run — read before the numbers
- **Route changed under M7.** `~/eta-router/router_server.py` was edited today at **11:44:15**; the backup `.bak-vad-20260914114415` has the same sha256 as the file M6 read (`a4700494…`). The router restarted at **11:46:36** (PID 1260). The new code adds a silence gate: near-silent VAD spans skip the engines, and no-speech windows get no fixed-window fallback. **M7's route arm is not the code M3 timed or M6 cited**; the override is now at `:481`, the timeline at `:578`. I did not make this change.
- **W03's 500 is a defect in that new code, inferred from the traceback and not reproduced.**
  - **Mechanism:** skipped spans `continue`, but `results = [None] * len(seg_jobs)` is still indexed by the original span `idx`. So `results[idx] = fut.result()` raises `IndexError`, and the `except` at `:559` raises it again.
  - **Log evidence:** `router.err.log` has exactly one `silent_skipped span` line (0.3 s long, at about 87 s), immediately followed by the chained traceback.
  - **Other windows:** the other 9 report `n_skipped_silent: 0`, so the gate removed nothing from them.
  - **No retry, no substitute window:** the same audio gives the same spans.
- **Sample.**
  - **Source:** `even-scribe-stt-drain/_exports` holds 24 × 300 s WAVs, but they are only **12 unique recordings**; six bundles duplicate files in the seventh (checked by sha256). All ten windows come from that **one bundle**, whose file name refers to OPD-7.
  - **Room and day:** per V's ruling, treat the ten as **one room, one day**. Any room-specific acoustic effect is confounded with the result, and no cross-room claim can be made. I verified the single bundle only; room and date are in the drain queue's job labels, and my read of `queue.sqlite` was blocked.
  - **Selection:** widest speech-ratio spread. Keep both extremes; from each of the two closest pairs (0.040/0.047, 0.362/0.364), drop the member whose removal leaves the larger smallest gap.
  - **Window length:** 300 s, not 900 s. No 900 s window exists locally.
- **Order:** per window, whisper then route, back to back, windows in ascending speech ratio. Log deltas show exactly 1 whisper POST per whisper arm and 1 route POST per route arm, so there was no outside traffic.
- **Lost corpus, per the amendment:** `.prerepair` files in the drain repo: **0**. `out/` holds 2 job folders plus `vad_smoke`. The whole-home search was stopped before it finished.

## Whisper arm parameters
- **Request:** `POST localhost:8081/inference` (whisper-shim → whisper-server :8080, PID 1813, running since 10 Sep). One request per 300 s window, form fields `response_format=verbose_json`, `temperature=0.0`, nothing else.
- **Server:** plist flags `-m ggml-large-v3-turbo.bin --vad --vad-model for-tests-silero-v6.2.0-ggml.bin --no-speech-thold 0.7 --suppress-nst`.
- **Binary defaults** (`--help`):
  - decoding: `--best-of 2`, `--beam-size -1` (greedy), temperature fallback on (`--no-fallback false`);
  - context: `--max-context -1` (full previous-text context, whisper.cpp's version of `condition_on_previous_text=true`);
  - language: `-l en`;
  - VAD: threshold 0.50, min speech 250 ms, min silence 100 ms, pad 30 ms.
- **Segmentation:** whisper's own 30 s decode windows inside the one request. All 10 responses report language `english`.
- **Route arm:** `POST 127.0.0.1:8083/route` with `file` and `translate=false`, as M3.

## 3.1 + 3.2: speech ratio and the three repeat definitions, per window
Speech ratio = silero-vad 6.2.1 `get_speech_timestamps` (defaults, 16 kHz) summed ÷ 300 s, run read-only from the router's venv.
A = M5 rule A, loops / repeat_ratio. B = identical + near-identical runs / characters beyond the first. C = identical segment runs / segments beyond the first. M4 = characters removed by M4 collapse. Trip* = interpreted PR #2 tripwire (see Flags), shown as modal dominance, longest identical run. w = whisper, r = route.

| Win | speech | w A | r A | w B | r B | w C | r C | M4 w / r | Trip* w | Trip* r |
|---|---|---|---|---|---|---|---|---|---|---|
| W01 | 0.006 | 0 / 0.000 | 0 / 0.000 | 0+0 / 0 | 0+0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1.00, 1 | 1.00, 1 |
| W02 | 0.047 | 1 / 0.413 | 0 / 0.000 | 2+0 / 31 | 0+0 / 0 | 2 / 3 | 0 / 0 | 148 / 0 | 0.42, 3 | 0.50, 1 |
| W03 | 0.136 | 1 / 0.031 | 500 | 0+1 / 48 | 500 | 2 / 3 | 500 | 46 / — | 0.12, 3 | 500 |
| W04 | 0.208 | 1 / 0.031 | 0 / 0.000 | 6+0 / 160 | 1+0 / 18 | 6 / 9 | 0 / 0 | 169 / 19 | 0.13, 4 | 0.12, 1 |
| W05 | 0.312 | 3 / 0.147 | 0 / 0.000 | 7+1 / 319 | 0+0 / 0 | 8 / 13 | 0 / 0 | 362 / 0 | 0.29, 6 | 0.20, 1 |
| W06 | 0.338 | 5 / 0.626 | 0 / 0.000 | 7+0 / 1267 | 0+0 / 0 | 7 / 35 | 0 / 0 | 1361 / 0 | 0.51, 22 | 0.11, 1 |
| W07 | 0.364 | 2 / 0.962 | 1 / 0.142 | 2+0 / 3306 | 1+0 / 238 | 2 / 87 | 0 / 0 | 3393 / 278 | 0.98, 76 | 0.11, 1 |
| W08 | 0.512 | 3 / 0.765 | 0 / 0.000 | 3+1 / 2120 | 0+0 / 0 | 5 / 52 | 0 / 0 | 2131 / 0 | 0.58, 46 | 0.11, 1 |
| W09 | 0.627 | 0 / 0.000 | 0 / 0.000 | 1+0 / 6 | 0+0 / 0 | 1 / 1 | 0 / 0 | 7 / 0 | 0.10, 2 | 0.09, 1 |
| W10 | 0.726 | 0 / 0.000 | 0 / 0.000 | 0+0 / 0 | 0+0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0.01, 1 | 0.09, 1 |

**Pooled over the 9 matched windows:**
- **A:** redundant characters 6,964 of 18,132 (whisper) vs 271 of 14,784 (route).
- **B:** 30 runs / 7,209 chars (whisper) vs 2 runs / 256 chars (route).
- **M4 collapse:** 0.418 of characters removed (whisper) vs 0.020 (route).
- **Trip*, AND verdict:** whisper 1 window, route 0. **OR verdict:** whisper 4, route 1.

**Pattern, described only:** whisper's A-loops occur in all 7 windows between 0.047 and 0.512 speech ratio (W02–W08), and in none at 0.006, 0.627 or 0.726.

## 3.3 + 3.5: engines, volume and time per window
| Win | w chars / segs | r chars / segs | w wall s / RTF | r wall s / RTF | r ÷ w | route winners (lang) |
|---|---|---|---|---|---|---|
| W01 | 14 / 1 | 29 / 1 | 3.11 / 0.010 | 14.19 / 0.047 | 4.56 | sravaani 1 (hi) |
| W02 | 259 / 19 | 272 / 2 | 3.44 / 0.011 | 16.64 / 0.056 | 4.84 | indicconformer 1 (ml), sravaani 1 (kn) |
| W03 | 743 / 26 | — | 3.95 / 0.013 | 23.87 / 0.080 | — | HTTP 500 |
| W04 | 826 / 38 | 1143 / 8 | 5.58 / 0.019 | 56.39 / 0.188 | 10.11 | sravaani 4 (kn), whisper 4 (en) |
| W05 | 1542 / 73 | 1472 / 5 | 7.63 / 0.025 | 49.47 / 0.165 | 6.48 | sravaani 4 (gu 3, hi 1), whisper 1 |
| W06 | 2049 / 61 | 1606 / 9 | 7.43 / 0.025 | 77.24 / 0.258 | 10.40 | sravaani 6 (kn), whisper 3 |
| W07 | 3436 / 91 | 1911 / 9 | 8.67 / 0.029 | 83.98 / 0.280 | 9.69 | sravaani 4 (kn), whisper 5 |
| W08 | 2637 / 79 | 1810 / 9 | 10.27 / 0.034 | 125.85 / 0.419 | 12.25 | sravaani 7 (kn), whisper 2 |
| W09 | 3619 / 125 | 3127 / 11 | 11.21 / 0.037 | 97.72 / 0.326 | 8.72 | whisper 10, sravaani 1 (und) |
| W10 | 3750 / 75 | 3414 / 11 | 9.70 / 0.032 | 110.95 / 0.370 | 11.44 | whisper 8, sravaani 3 (und) |

- **Route segments:** 65. Duration min 1.7 s, median 27.3 s, max 29.8 s. The per-segment table is in the JSON.
- **Winners:** whisper 33 (all `en`); SraVaani 31 (`kn` 22, `und` 4, `gu` 3, `hi` 2); IndicConformer 1 (`ml`).
- **Speed, 9 windows:** whisper **0.025×** realtime, route **0.234×**, so route takes **9.43×** as long. Per window, route runs 0.047–0.419×.
- **Against M3:** M3's 0.326–0.382× on continuous synthetic speech matches only the three windows at or above 0.512 speech ratio (0.419, 0.326, 0.370). Real audio at lower speech ratios runs faster.

## 3.4: script census (M6 method unchanged; tokens / chars)
- **Whisper:** Latin in every window, 3,803 tokens across the 10. Its "other" bucket is mostly digit-only tokens (W08 has 47), plus single Cyrillic, Hangul and CJK+Latin tokens in W05 and W08.
- **Route, native script in 7 of 9 windows:**
  - Kannada: W02 41/218, W04 106/602, W06 229/1240, W07 154/838, W08 229/1177;
  - Devanagari: W01 8/22, W05 69/211;
  - W09 and W10 are Latin only.
- **"other" hides scripts:** M6 names only 5 scripts. Route's "other" is **246 Gujarati tokens (906 chars) in W05** and 2 Malayalam tokens in W02; everything else in it is digits. This breakdown is a supplement; the census itself is unchanged.
- Full per-window, per-arm census is in the JSON.

## Files
- `scratch/M7-MEASURE-14-SEP-2026.py.txt`: runs the M4, M5 and M6 scripts unchanged plus its own self-tests, and prints numbers only.
- `scratch/M7-MEASURE-OUT-14-SEP-2026.json`: no transcript fields (checked).
- **PHI held outside the repo:** audio, raw engine outputs and the label mapping are in the session scratchpad (`/private/tmp/…/scratchpad/m7/`). Nothing was deleted.

## Flags
1. **PR #2 tripwire, interpreted.** PR #2's PRD is not on disk. The kickoff says "≥ 0.60 **and** run ≥ 8"; `ETA-PROGRAMME-INTEGRATION` line 95 says "**or**". I used: modal dominance = the most frequent normalised segment text ÷ non-empty segments; run = longest consecutive identical run. I report both verdicts. A one-segment window (W01) trips "or" trivially on both arms.
2. **Rule C units differ.** Whisper's segments average about 4–5 s; route's are VAD spans up to 30 s. C counts are not like-for-like.
3. **The pooled speed ratio (9.43×)** includes route's silence gate and is on 300 s windows. M3's 8.30× used the old router on one 900 s synthetic clip.
4. **Speech ratio ran on a different stack.** silero-vad (Python, router venv) is not whisper-server's ggml VAD, and not route's own per-span RMS gate.
5. **Not checked:**
   - losing engines' outputs;
   - W03's route arm;
   - any second room or day;
   - whether today's router edit came with a kickoff;
   - `queue.sqlite` (read blocked).

---

## W03 ADDENDUM — route arm re-run after the IndexError fix (14 Sep, 13:43:43 IST)
**Router state, checked read-only first.**
- `router_server.py` differs from `router_server.py.bak-idxfix-20260914` in one line only: `:550` is now `[None] * len(spans)`.
- The router is PID 41433, started 13:35:48; `/healthz` 200; drain queue empty.

**What ran.** Route arm only: the same `W03.wav`, `POST 127.0.0.1:8083/route` with `file` and `translate=false`. Whisper was not re-run; W03's whisper arm is M7's from 13:09. No router code or config and no whisper setting was touched.
- **Log deltas during the run:** 1 route POST, 5 whisper calls made by route, **1 `silent_skipped span` line, 0 tracebacks**.
- **Evidence kept:** M7's original 500 body is untouched. The re-run output is private, in the scratchpad.
- **Measurement:** `M7-MEASURE` ran unchanged over all 10 windows, with W03's route result replaced → `scratch/M7-W03-ADDENDUM-OUT-14-SEP-2026.json` (checked free of transcript text). `M7-MEASURE-OUT` is untouched.

**(a) HTTP status:** 200. **(b) `n_skipped_silent`:** 1. `n_segments` is 4 and `n_engine_segments` 3.

**(c) Per-segment winners**
| seg | engine | lang | dur s | chars |
|---|---|---|---|---|
| 0 | sravaani | und | 28.3 | 319 |
| 1 | whisper | en | 20.5 | 207 |
| 2 | whisper | en | 10.3 | 73 |

**(d) W03 rows for the M7 tables** (same columns)

| Win | speech | w A | r A | w B | r B | w C | r C | M4 w / r | Trip* w | Trip* r |
|---|---|---|---|---|---|---|---|---|---|---|
| W03 | 0.136 | 1 / 0.031 | 0 / 0.000 | 0+1 / 48 | 0+0 / 0 | 2 / 3 | 0 / 0 | 46 / 0 | 0.12, 3 | 0.33, 1 |

| Win | w chars / segs | r chars / segs | w wall s / RTF | r wall s / RTF | r ÷ w | route winners (lang) |
|---|---|---|---|---|---|---|
| W03 | 743 / 26 | 594 / 3 | 3.95 / 0.013 | 26.92 / 0.090 | 6.82 | sravaani 1 (und), whisper 2 (en) |

- **Script census:** whisper Latin 151/544, other 3/3 · route **Latin 127/455 only**. The SraVaani `und` segment is Latin-script text, like the synthetic clip's segment 11 in M6.
- **Route `sec`:** 26.88.
- **Tripwire\*:** both verdicts false on route.

**Do M7's pooled route figures change?** Yes: volume, the ratio denominators, timing and engine totals change. The repeat numerators do not, because W03's route arm has zero repeats under every definition. Corrected pooled figures, all 10 windows now matched on both arms:

| Pooled | M7 (9 matched) | Corrected (10) |
|---|---|---|
| route chars | 14,784 | **15,378** |
| route A: redundant chars / repeat_ratio | 271 / 0.0183 | 271 / **0.0176** |
| route A: windows with a loop | 1 of 9 | **1 of 10** |
| route B: runs / chars | 2 / 256 | 2 / 256 |
| route M4 removed ratio | 0.0201 | **0.0193** |
| route C runs | 0 | 0 |
| route Trip\* AND / OR windows | 0 / 1 | 0 / 1 (W01's trivial one-segment trip) |
| route segments | 65 | **68** |
| route winners: whisper / SraVaani / IndicConformer | 33 / 31 / 1 | **35 / 32 / 1** (IndicConformer 1 of 68) |
| route lang: en / kn / und / gu / hi / ml | 33 / 22 / 4 / 3 / 2 / 1 | **35** / 22 / **5** / 3 / 2 / 1 |
| whisper A repeat_ratio, matched set | 0.384 (9) | **0.370** (10; loops in 7 of 10) |
| whisper M4 removed ratio, matched set | 0.418 (9) | **0.404** (10) |
| RTF whisper / route | 0.025 / 0.234 | **0.024 / 0.220** |
| route ÷ whisper wall, pooled | 9.43× | **9.29×** |

**The lead sentences with W03 included:** IndicConformer won **1 of 68** route segments. Under M5 rule A, whisper's pooled repeat_ratio is **0.370** (loops in 7 of 10 windows) against route's **0.018** (0.0176; 1 of 10).

**Addendum flags**
- **Timing is not strictly back-to-back.** W03's route arm ran 34 minutes after its whisper arm, on a different router process (PID 41433 against 1260), with one line of code different. The other nine route arms ran on PID 1260.
- **One M7 pooled figure is superseded.** M7's own JSON aggregate (`route_rtf_pooled` 0.2188) counted the failed call's 23.87 s. The corrected 10-window route wall is 659.35 s: the nine completed windows plus the re-run.
- **Length cap.** This addendum takes the report past its original 110-line cap, as ordered.
