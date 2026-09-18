# ETA — W4: REQUEST LENGTH vs `max_context` — REPORT
**14 Sep 2026 · whisper-alone, window W07, 15:23:46–15:25:23 IST · per-request field only · no config, plist or router change · no git**

**No: on a 30 s request, `max_context=0` made no detectable difference.** The test used the 5 of 10 slices whose text was identical across both repeats under *both* settings; on those, `max_context=0` changed the text on **0**. The other 5 slices varied run to run under the same setting, so their differences cannot be attributed. The pooled slice metrics under `max_context=0` sit inside or at the edge of the default runs' own spread. On the full 300 s request, the same field cuts the repeat ratio from 0.962 to 0.30–0.38, far outside the floor. On this window, **request length is the lever, and `max_context` only matters on long requests.**

**Why W07:** deterministic as a full request in W3 (identical text on 3 passes, spread 0), and the largest context effect in W2 (0.962 → 0.325). **Setup:** M7's fields (`POST localhost:8081/inference`, `response_format=verbose_json`, `temperature=0.0`, plus `max_context=0` in ctx0 runs) on (a) one 300 s request and (b) 10 non-overlapping 30.0 s WAV slices of the same audio, one request each. Each ran twice per setting: 44 requests, all 200; log delta 44 whisper POSTs (as expected), 0 route POSTs.

| Run | requests | chars | repeat_ratio A | loops A | M4 fraction | segments | wall s |
|---|---|---|---|---|---|---|---|
| full, default, r1 | 1 | 3,436 | 0.962 | 2 | 0.988 | 91 | 8.57 |
| full, default, r2 | 1 | 3,436 | 0.962 | 2 | 0.988 | 91 | 8.57 |
| full, `max_context=0`, r1 | 1 | 2,087 | 0.377 | 5 | 0.406 | 55 | 9.41 |
| full, `max_context=0`, r2 | 1 | 1,768 | 0.295 | 2 | 0.399 | 58 | 9.34 |
| slices, default, r1 | 10 | 2,112 | 0.320 | 5 | 0.346 | 83 | 14.45 |
| slices, default, r2 | 10 | 2,191 | 0.238 | 3 | 0.278 | 85 | 15.65 |
| slices, `max_context=0`, r1 | 10 | 2,031 | 0.239 | 2 | 0.354 | 77 | 15.07 |
| slices, `max_context=0`, r2 | 10 | 2,100 | 0.249 | 3 | 0.291 | 85 | 15.80 |

Slice rows are the ten slice texts joined in order. Metrics are M7's, unchanged.

## Against the noise floor
- **Full request, context effect:** default is deterministic (W3 spread 0 on W07; r1 = r2 here). `max_context=0` lowers the repeat ratio by **0.585–0.667** and characters by **1,349–1,668**. W2's earlier `max_context=0` run on W07 (0.325 / 1,963) falls inside that ctx0 range. The full request with context off is itself **not** deterministic (r1 ≠ r2).
- **Slices, context effect: not distinguishable.**
  - **Within-setting spread:** default repeats differ by 0.082 in repeat ratio and 79 chars. `max_context=0` repeats differ by 0.010 and 69 chars.
  - **Between settings:** ctx0's repeat ratios (0.239, 0.249) lie inside default's range (0.238–0.320). Its characters (2,031–2,100) are 12–81 below default's lowest, within the within-setting spread.
  - **Per slice:** default repeats identical on 7 of 10, ctx0 repeats on 5 of 10, all four runs identical on 5 of 10.
- **Request length, context left on:** full → slices lowers the repeat ratio by **0.642–0.724** and characters by **1,245–1,324**. That is far outside W07's full-request spread (0) and W3's pooled spread (0.065 / 1,122 chars).

**What this implies for the fix**, conditional on this window generalising: the fix belongs on the long-audio whisper callers, not the router. Those are the app's room-drain, encounter processing, whisper-chunk, the STT adapter, and the Mini's stt-drain (per W1 §3.1). Either shorten their requests, or send `max_context=0` where long requests stay.

**Request length does not explain everything on W07:**
- **Slicing alone** still leaves 0.24–0.32.
- **Route** on the same window measured 0.142 in M7 and 0.000 in W1 arm 2. Route uses VAD spans rather than hard 30 s cuts, and adds its English guard and the other engines. The gap between slices and route is not attributed here.

**Flags.** (1) **Thin sample:** one window, two repeats per setting. (2) **Evidence, not proof:** a ≤ 30 s request can still take more than one decode pass (whisper.cpp's seek loop), so "no detectable difference" is empirical, on 5 stable slices. (3) **Cut style:** hard 30.0 s cuts can split words; route's are VAD spans of 1.7–29.8 s. Slice requests are **less deterministic** than the full request with context on; cause unverified. (4) **Files:** `scratch/W4-MEASURE-14-SEP-2026.py.txt` (M7 metrics unchanged) and `scratch/W4-MEASURE-OUT-14-SEP-2026.json` (numbers and booleans only; checked free of transcript text). Slices and raw outputs are private, in the session scratchpad.
