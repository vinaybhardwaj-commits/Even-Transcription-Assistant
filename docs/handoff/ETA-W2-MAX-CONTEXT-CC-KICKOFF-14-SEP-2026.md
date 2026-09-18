# ETA — W2: `--max-context` IS THE LEADING SUSPECT FOR THE 37% — TEST IT
**14 September 2026 · Session: `scribe3` · Mini config change · run BEFORE W1**

## 0. Why this runs first

It is the biggest number in the programme and the cheapest experiment we have. Whisper alone is **0.025×
realtime**, so ten 300-second windows is **about 75 seconds of compute**. The figure under test is
**0.370 repeat ratio — 37% of whisper's output on real room audio is redundant text.**

## 1. The suspicion, stated so you can refute it

Whisper-server runs with `--max-context -1`: full previous-text context, whisper.cpp's equivalent of
`condition_on_previous_text=true`. PR #2's VAD PRD mandates that setting be **off**.

**M7 killed the alternative explanation.** I had ruled that pre-decode silence gating would remove most of
whisper's disadvantage. It will not: whisper **already** runs `--vad --vad-model …silero…
--no-speech-thold 0.7 --suppress-nst`, and still returns 0.370. The gate is on and the looping persists.

**And M7's loop pattern fits context carry-over precisely.** Loops appear in all 7 windows between 0.047
and 0.512 speech ratio, and in **none** at 0.006, 0.627 or 0.726. At near-silence there is nothing to
repeat; at continuous speech there is no gap to carry context across; in between — speech islands separated
by pauses, which is what a consultation sounds like — context crosses each gap and the model repeats.

That is a hypothesis with a mechanism. **Test it. Do not assume it.**

## 2. W2.1 — Establish the exact lever before touching anything

Read-only, report verbatim:
1. The whisper-server plist, every flag.
2. `--max-context` in `--help`: its meaning, its default, and what values are legal. Does `0` mean "no
   context" or "unlimited"? **Get this right from the help text, not from intuition** — an off-by-one here
   inverts the whole experiment.
3. Whether `max_context` can be passed **per request** to `:8081/inference` or only as a server flag.
4. Every other caller of that whisper server, and whether this change would affect them.

**Prefer a per-request parameter if one exists** — it scopes the change to the measurement and reverts by
doing nothing. Only change the plist if it does not.

## 3. W2.2 — Change exactly one thing

Set the no-context value you established in §2.1. **Change nothing else.** Do not touch the language flag —
that is W1 and it runs after this. Do not touch VAD flags, `--no-speech-thold`, `--suppress-nst`,
`--best-of`, beam or temperature. Do not touch the router.

If you edit the plist: **back it up byte-for-byte first, record the original verbatim in the report, and
write the restore command down before you restart anything.** Confirm the server comes back and the model
loads before measuring.

## 4. W2.3 — The measurement

**Whisper arm only.** Route is not needed to answer this question and costs 11 minutes we do not have to
spend. Same ten windows, same order, same script.

Report, against the M7 baseline, side by side:
- **repeat_ratio under M5 rule A, per window and pooled** — the headline
- rule B runs and characters; the M4 collapse fraction
- **which windows loop**, so the 0.047–0.512 band can be checked directly
- characters produced per window — **watch for text disappearing**, not just repetition falling
- wall clock and realtime factor

**The decisive number: pooled whisper repeat_ratio, 0.370 versus after.**

## 5. The trap — read this before you interpret the result

**A drop in repeat_ratio is not automatically a win.** Removing context can also make whisper produce
*less text overall*, including real speech, because each 30-second window loses the run-up that helps it
resolve a word straddling a boundary. **Report the character count next to the repeat ratio every time.**
A ratio that falls while characters fall further is a loss wearing a win's clothes.

If repeat_ratio drops and characters hold roughly steady, the setting was the cause and we have our fix.
If both drop sharply, say so plainly — the ruling is mine.

## 6. Constraints

No repo changes, no git, no migrations, no deploy, no flags. The whisper-server config is the only write.
**Do not quote transcript text** — real clinical audio; counts, ratios and language labels only.
`scribe` may be querying the database; it will not touch the Mini.

**Restore the original configuration when the measurement is done**, unless I have ruled otherwise by then,
and say in the report which state you left the server in. A production service must not be left on an
experimental setting by default.

## 7. Report

`docs/handoff/ETA-W2-MAX-CONTEXT-14-SEP-2026.md`, **cap 70 lines**. Lead with two numbers in one sentence:
pooled repeat_ratio before and after, and total characters before and after. Then §2 findings, the exact
change, the per-window table, the restore state, and flags.

## 8. Known facts

- M7 baseline, 10 windows, whisper arm: repeat_ratio **0.370**, loops in **7 of 10** windows, M4 collapse
  fraction 0.418 over the 9 originally matched.
- Whisper params today: `-m ggml-large-v3-turbo.bin --vad --vad-model for-tests-silero-v6.2.0-ggml.bin
  --no-speech-thold 0.7 --suppress-nst`; binary defaults `--best-of 2`, `--beam-size -1`, temperature
  fallback on, `--max-context -1`, `-l en`.
- Request shape: `POST localhost:8081/inference`, `response_format=verbose_json`, `temperature=0.0`.
- Route now runs the fixed router (PID 41433, `results` sized by `len(spans)`), backup
  `router_server.py.bak-idxfix-20260914`. **Do not change the router in this round.**
- Tailscale: ~60 s ceiling, single `/usr/bin/python3 - <<'PY'` heredoc, absolute paths, never `$HOME`.
