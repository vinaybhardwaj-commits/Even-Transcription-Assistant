# ETA — M3: IS THE THREE-ENGINE RACE WORTH IT? — CC KICKOFF
**14 September 2026 · Session: `scribe3` · Mini only. READ-ONLY: no code change, no env change, no restart.**

M2 is accepted. It produced a number and a surprise, and this order chases the surprise.

## 0. What M2 found

`route` runs at **0.326–0.342× realtime** — ~293–308 s for a 900 s window, serialised — so the router's
capacity is **≈12 windows/hour** against **24/hour** produced by six rooms. And of 32 segments, **whisper
produced 30, SraVaani 2, IndicConformer 0**, even though ~200 s of the clip was Hindi, Kannada, Tamil or
Telugu. Segments run up to 30 s, so short non-English passages share a segment with English and the
longest-result-wins rule picks English.

**The question: what are the other two engines actually buying us, and what would we save without them?**

## 1. Use the SAME clip

Reuse the exact 900 s clip from M2 — same file, no rebuild — so every number below is comparable with
M2's. Name the file path in the report. If the file is gone, say so and stop; do not build a different one.

## 2. Measure, in this order, nothing else running

1. **whisper alone, same clip.** `POST` it straight to the whisper service, the same way the router calls
   it. Report wall time, **realtime factor (wall ÷ 900)**, and the transcript's character count.
2. **`route` again, `translate=false`** — one run, to confirm M2's 0.326 still reproduces after the M1
   restarts and to give whisper-alone a same-session comparison. Report the same three numbers.
3. **The delta.** whisper-alone wall vs route wall, as a ratio, and the character-count difference between
   the two transcripts. Do **not** judge quality — report how much text each produced and leave it there.
4. **Concurrency at current settings.** Two `route` calls on the same clip fired together. Report each
   call's wall and `sec`, the total wall for both, and whether total throughput improved at all over
   running them one after the other. Remember M1 made `sec` include queue wait — say how much of the
   second call's `sec` is waiting.
5. **Memory headroom while one 900 s route runs.** Peak RSS per service and free system RAM at the
   trough. This decides whether raising concurrency is even possible; it is NOT permission to raise it.

## 3. Report the live settings, do not change them

Report the current values of `ETA_MAX_INFLIGHT`, `ETA_MAX_WINDOWS_INFLIGHT` and `SEG_SEC` as the running
service actually has them, and where you read them from. **Change none of them.** If a value cannot be
read without restarting something, say it is unread rather than restarting.

## 4. Do not

Change any code, env var, model or config · restart any service · touch the app repo with git ·
recommend a cap, a concurrency setting or a segment length — those are the Orchestrator's rulings ·
extrapolate any number you did not measure.

## 5. Report

`docs/handoff/ETA-M3-ROUTER-CONCURRENCY-14-SEP-2026.md` (file only, no commit), at most 450 words:
a table of every run with its realtime factor in its own column · the whisper-vs-route delta ·
the concurrency result · memory headroom · the three live settings · what you did not check.
