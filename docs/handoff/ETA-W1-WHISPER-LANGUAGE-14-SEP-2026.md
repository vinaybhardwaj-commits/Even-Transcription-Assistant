# ETA — W1: WHISPER LANGUAGE — REPORT
**14 Sep 2026 · Builder · plist untouched · router restored and verified · no git, no commit**

**IndicConformer won 1 of 68 route segments at baseline and 1 of 68 with `language=auto` (arm 2). Route's native-script characters went 5,227 → 5,125 (total 15,378 → 15,455). Whisper-alone's went 0 → 0 (total 18,875 → 20,132).**

**Arm 1's null result is a finding.** whisper.cpp detects language **once per request, from offset 0**: `whisper.cpp:6822` calls `whisper_lang_auto_detect_with_state(ctx, state, 0, …)`, and `server.cpp:1069` also detects at offset 0. So a 300 s window that opens in English is decoded as English for all 300 s. That is why whisper-alone produced zero native script in all ten M7 windows, and why `auto` detected `english` on all ten here (p 0.63–0.999). **Segment length therefore sets how often language detection runs at all.** Only route's per-segment calls give `auto` a chance, which is a deeper reason route wins than the override threshold.

## §3.1 findings (read-only)
1. **Plist** (unchanged): `whisper-server -m …/ggml-large-v3-turbo.bin --vad --vad-model …/for-tests-silero-v6.2.0-ggml.bin --no-speech-thold 0.7 --suppress-nst --port 8080`. No `-l`, so the server default is `en`.
2. **The router asks for a language it never reads back.**
   - `whisper_infer` (`router_server.py:122–134`) sends `response_format=json` and `temperature`, plus `language` only if the caller passes one; the first call (`:402`) passes none.
   - `json` output returns only `{"text"}` (`server.cpp:1137`), so `w_lang` is always `""`.
   - So `w_lang != "en"` (`:447`) is **always true**, and **every English-won segment is re-decoded with `language="en"`** (`:449`).
   - M7 and arm 2 logs agree: whisper calls per route run = segments + whisper-won segments.
   - Correction: my M7 note said this check was "effectively never true".
3. **Language can be set per request.** `server.cpp:560` reads `language`. `auto` is valid (`--help`; `server.cpp:645` rejects only unknown codes; `whisper.cpp:6819`). Explicit codes are the alternative.
4. **Most production callers send no language either, so the app's own whisper calls are English-forced.** This is wider than the router and needs its own round.
   - **App** (`lib/whisper.ts:281`): sends `language` only when a caller passes one.
     - None passed: `lib/stt/room-drain.ts:662, :727`, `app/[slug]/api/encounters/[id]/process/route.ts:245`, `app/[slug]/api/transcribe/whisper-chunk/route.ts:149`, `lib/stt/adapters/whisper.ts:8`, `lib/stt/measure-job.ts:389`.
     - Optional, operator-set: `lib/mcp/tools/bench.ts:1667`, `lib/jobs/kinds/transcribe-range.ts:76`.
   - **Mini:** `stt_drain.py` sends none. `eta-probe`, `whisper-probe` and the dashboard are health calls.

## Changes made
- **Arm 1 (confined), 14:36:05–14:37:21:** M7's whisper request plus the form field `language=auto`. No config written.
- **Arm 2:** one line, `router_server.py:402` `whisper_infer(seg_wav)` → `whisper_infer(seg_wav, language="auto")`. Compiled, then restarted.
- **Unchanged:** `max_context`, the override, segmentation, the silence gate, the `:449` re-call.
- **Altered-code window: 14:41:21 (restart onto the edit) – 14:53:39 (backup restored and restart issued).** /route traffic during this window ran the edited code. Arm 2's requests ran 14:41:50–14:53:38, with 1 route POST per window in the logs.

## Rollback — written before the edit, executed at 14:53:39
- **Backup:** `router_server.py.bak-w1-lang-20260914143924`, sha256 `fb88344ab115a6309dac96b810cbf3f361caa4dedcfb76d2c8e132318e26cc40`.
- **Command:** `cp -p <backup> /Users/vinaybhardwaj/eta-router/router_server.py && launchctl kickstart -k "gui/$(id -u)/com.vinaybhardwaj.eta-router"`
- **Before measuring:** PID 47545, `/healthz` 200 at 14:41:23. **After restore:** PID 49336, `/healthz` 200 at 14:53:52; live sha256 = backup (`cmp` identical); `:402` reverted; the `:550` IndexError fix still present.

## Arm 1 — whisper alone, `en` → `auto` (per window)
| Win | speech | chars | repeat_ratio A | B runs/chars | detected (p) | wall s |
|---|---|---|---|---|---|---|
| W01 | 0.006 | 14 → 14 | 0.000 → 0.000 | 0/0 → 0/0 | english (0.881) | 3.11 → 3.59 |
| W02 | 0.047 | 259 → 259 | 0.413 → 0.413 | 2/31 → 2/31 | english (0.723) | 3.44 → 3.86 |
| W03 | 0.136 | 743 → 743 | 0.031 → 0.031 | 1/48 → 1/48 | english (0.998) | 3.95 → 4.46 |
| W04 | 0.208 | 826 → 936 | 0.032 → 0.661 | 6/160 → 2/641 | english (0.721) | 5.58 → 5.43 |
| W05 | 0.312 | 1542 → 1496 | 0.147 → 0.224 | 8/319 → 13/454 | english (0.631) | 7.63 → 7.14 |
| W06 | 0.338 | 2049 → 2049 | 0.626 → 0.626 | 7/1267 → 7/1267 | english (0.836) | 7.43 → 7.95 |
| W07 | 0.364 | 3436 → 3436 | 0.962 → 0.962 | 2/3306 → 2/3306 | english (0.885) | 8.67 → 9.05 |
| W08 | 0.512 | 2637 → 3636 | 0.765 → 0.836 | 4/2120 → 2/3058 | english (0.927) | 10.27 → 10.67 |
| W09 | 0.627 | 3619 → 3813 | 0.000 → 0.000 | 1/6 → 1/6 | english (0.999) | 11.21 → 11.83 |
| W10 | 0.726 | 3750 → 3750 | 0.000 → 0.000 | 0/0 → 0/0 | english (0.999) | 9.70 → 10.17 |

**Pooled:**
- **Characters 18,875 → 20,132.** Rule A repeat_ratio 0.370 → 0.433; windows with a loop 7 → 7.
- **Rule B:** runs 31 → 30; chars 7,257 → 8,811.
- **M4 collapse fraction:** 0.404 → 0.460.
- **Trip\* AND/OR windows:** 1/4 → 3/5.
- **Native-script chars 0 → 0.** Realtime factor 0.0237 → 0.0247.

## Arm 2 — route, `en` → `auto` on the first whisper call (per window)
Winners: W = whisper, S = SraVaani, IC = IndicConformer.

| Win | chars | winners | native chars (all-Indic) | repeat_ratio A | B runs/chars | wall s |
|---|---|---|---|---|---|---|
| W01 | 29 → 16 | S1 → W1 | 22 → 0 | 0.000 → 0.000 | 0/0 → 0/0 | 14.19 → 9.06 |
| W02 | 272 → 478 | IC1, S1 → IC1, W1 | 231 → 13 | 0.000 → 0.224 | 0/0 → 3/146 | 16.64 → 20.65 |
| W03 | 594 → 594 | S1, W2 → same | 0 → 0 | 0.000 → 0.000 | 0/0 → 0/0 | 26.92 → 22.67 |
| W04 | 1143 → 1143 | S4, W4 → same | 602 → 602 | 0.000 → 0.000 | 1/18 → 1/18 | 56.39 → 64.67 |
| W05 | 1472 → 1452 | S4, W1 → same | 1117 → 1117 | 0.000 → 0.000 | 0/0 → 0/0 | 49.47 → 73.18 |
| W06 | 1606 → 1591 | S6, W3 → same | 1240 → 1027 | 0.000 → 0.000 | 0/0 → 0/0 | 77.24 → 85.08 |
| W07 | 1911 → 1803 | S4, W5 → S5, W4 | 838 → 1189 | 0.142 → 0.000 | 1/238 → 0/0 | 83.98 → 98.29 |
| W08 | 1810 → 1837 | S7, W2 → same | 1177 → 1177 | 0.000 → 0.000 | 0/0 → 0/0 | 125.85 → 107.12 |
| W09 | 3127 → 3127 | S1, W10 → same | 0 → 0 | 0.000 → 0.000 | 0/0 → 0/0 | 97.72 → 113.63 |
| W10 | 3414 → 3414 | S3, W8 → same | 0 → 0 | 0.000 → 0.000 | 0/0 → 0/0 | 110.95 → 112.32 |

**Pooled:**
- **Characters 15,378 → 15,455.** Rule A repeat_ratio 0.0176 → 0.0069.
- **Rule B:** runs 2 → 4; chars 256 → 164.
- **M4 collapse fraction:** 0.019 → 0.011.
- **Winners:** whisper 35 → 36, SraVaani 32 → 31, IndicConformer 1 → 1.
- **Language labels:** `hi` 2 → 1, `kn` 22 → 22 (W02 lost one, W07 gained one), `en` 35 → 36.
- **Native (all-Indic) 5,227 → 5,125;** M6-named scripts 4,308 → 4,206.
- **Realtime factor** 0.220 → 0.236.

**Which segments switched:** W01 (`hi` → `en`), W02 (`kn` → `en`), W07 (one `en` → `kn`). Whisper's first-call detection can't be seen, because `json` returns no language (finding 2).

## Flags
1. **No round has measured whisper's run-to-run variance, so small deltas in W1 and W2 are uncalibrated.**
   - Arm 1 characters changed in W04, W05, W08 and W09 although English was detected either way.
   - W2 saw W03 lose 4 characters under a setting that could not have touched it.
   - Arm 2's W05, W06 and W08 changed characters or native script with the same winners.
   - The large effects are not in doubt; the small ones are.
2. **W02 now carries a whisper loop inside route's output** (B 3/146), because the winner flipped from SraVaani to whisper.
3. **Baselines ran on different router processes, and the sample is M7's.** The route baseline ran on PID 1260 (9 windows) and PID 41433 (W03); arm 2 ran on PID 47545 (backup plus one line). Only W03 skips a silent span. One room, one day, 300 s windows, one run per setting.
4. **Two native-script counts.** "all-Indic" adds Gujarati and Malayalam, which M6's census files under "other"; M6-named counts only Devanagari, Kannada, Tamil and Telugu. Both are in `scratch/W1-MEASURE-OUT-14-SEP-2026.json` (numbers only; script `W1-MEASURE-14-SEP-2026.py.txt` asserts both baselines equal `M7-W03-ADDENDUM-OUT`).
