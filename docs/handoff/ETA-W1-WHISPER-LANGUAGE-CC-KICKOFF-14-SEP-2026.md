# ETA — W1: WHISPER IS FORCED TO ENGLISH — FIND IT, FIX IT, MEASURE IT
**14 September 2026 · Session: `scribe3` · Mini-side change · DO NOT START UNTIL M7 HAS REPORTED**

## 0. HOLD — the ordering is the whole point

**Do not touch any whisper configuration until M7 is finished and its report is written.** M7 is measuring
the current configuration on ten real segments. That run is the **baseline**, and if the configuration
changes underneath it the baseline is destroyed and both runs become uninterpretable. M7 first. Always.

## 1. What you found, and why it is probably the root cause of two separate mysteries

Your own reading, from the M7 setup:

> *"Whisper runs with English forced. The whisper-server plist passes no `-l`, so the server default `en`
> applies. The router's `whisper_infer` sends no `language` either, so on every segment it asks for English,
> and `w_lang != "en"` (`:408`) is effectively never true."*

This is very likely **why whisper writes Kannada, Tamil and Telugu in Latin letters** (M5: 625 characters
across 9 spans). We are asking an English transcriber to transcribe Kannada; transliteration is the only
thing it can do. It is not a model quirk, it is a flag.

And it compounds into M6's finding. If whisper always reports `en`, the check at `:408` never re-runs it,
the Indic candidate path is starved, and the override at `:439–443` never receives a competitive Indic
result — which is one reason **0 of 32 segments reached IndicConformer**. The 1.8× threshold I identified
is the *second*-order cause. This is the first.

## 2. The trap: this is not a flag flip, it is an experiment

**`language=auto` can make things worse.** Whisper's auto-detection on 30-second segments of code-mixed
speech is not reliable, and `looks_real_english()` exists in the router precisely because engine output
cannot be trusted. A misdetected English segment coming back as Hindi is a new failure mode we do not
currently have. **So this is measured, not assumed** — the rule that has paid for itself all day.

**Change ONE variable.** You also found `max_context -1` (whisper.cpp's `condition_on_previous_text=true`,
the loop amplifier PR #2 mandates be off). **That is a separate round.** Changing both at once makes the
result unattributable.

## 3. W1.1 — Establish the mechanism before changing anything

Report, with file and line, read-only:
1. The whisper-server launchd plist **verbatim** — every argument, the binary path, the model.
2. `whisper_infer` in `~/eta-router/router_server.py` — the exact request it builds, and what it does and
   does not send.
3. **Does the whisper server accept a per-request `language` parameter**, or only the server-level `-l`
   default? Answer from `--help` and from the server source, not from assumption.
4. **Every other caller of that whisper server** — the app's direct calls, the health probe, anything on
   8080/8081. For each: does it send a language, and what happens to it today? If the app's own calls are
   also defaulting to English, **say so** — that widens the defect well beyond the router.
5. Whether `-l auto` is even a valid value for this build, and what the alternatives are.

## 4. W1.2 — Prefer the narrowest change that can be measured

If the server accepts a per-request language, **change the router's `whisper_infer` to send it explicitly**
rather than changing the server default. Reasons: it is scoped to the router's calls, it leaves every other
caller on today's behaviour so the comparison stays clean, and it is reverted by one edit.

Only change the plist if a per-request parameter is not supported. If you do:
- **Back it up first**, byte-for-byte, and record the original verbatim in your report.
- Restart the service, confirm it is serving, and confirm the model loaded.
- Have the exact restore command written down **before** you restart anything.

## 5. W1.3 — The measurement

Re-run **M7's script, unchanged, on M7's exact ten segments**, with only the language behaviour different.
Report the same metrics against the baseline, side by side:
- per-segment **winning engine** and detected language → **did any segment reach IndicConformer?**
- **script census** (M6's method, unchanged) → did native script appear where there was none?
- all three **repeat-ratio** definitions
- **speech ratio** per segment (unchanged from baseline; it is a property of the audio, so it is also your
  check that you are on the same audio)
- characters produced, and wall-clock per segment

**The decisive number:** IndicConformer segment count, baseline versus after. Second: native-script
characters, baseline versus after. Lead with both.

## 6. Rollback

State your rollback in the report **before** the measurement section, so it exists if the round is
abandoned mid-way. If any Mini service fails to come back, restore immediately and report — do not debug
forward on a production service.

## 7. Constraints

No repo code changes, no git commit on the app repo, no migrations, no deploy, no flags. The `~/eta-router`
and plist edits are the only writes, and only per §4. **Do not quote transcript text** — real clinical
audio; counts, ratios and language labels only. `scribe` may be working in the database; it will not touch
the Mini.

Do not change `max_context`. Do not re-tune the 1.8× override. Do not touch the segmentation length.
Those are named rounds and each needs its own baseline.

## 8. Report

`docs/handoff/ETA-W1-WHISPER-LANGUAGE-14-SEP-2026.md`, **cap 90 lines**. Lead with the two decisive numbers
from §5. Then the §3 findings, the change you made, the rollback, the comparison table, and flags.

## 9. Known facts

- M3: route is 0.326–0.342× realtime and 8.30× slower than whisper alone; `SEG_SEC=30`,
  `ETA_MAX_INFLIGHT=1`.
- M6: 0 of 32 segments to IndicConformer; route's whole output held 17 Kannada tokens, 103 characters, all
  in one segment; whisper-alone produced no native script at all.
- The router's language timeline is built at `:504–505` **after** each engine is chosen — it is an output,
  never an input. Do not use it as ground truth for anything.
- The router has no `/health`; it serves `/healthz`.
- Tailscale: ~60 s ceiling, single `/usr/bin/python3 - <<'PY'` heredoc, absolute paths, never `$HOME`.
