# ETA — 24 Sep PM train. REFUTER VERDICT (L9). 24 Sep 2026

`vinay/train-24sep-pm` **@ `a30186c`**, on production `0e96d39`. Worktree `/tmp/refute-t24pm`. `tsc --noEmit` **rc=0**.

## PASS — with one documentation gap that is load-bearing for this particular feature

### Nothing rides without a verdict

| source commit | verdict |
|---|---|
| `e42b7e6` service-pools enable-blockers | **mine, PASS** |
| `5121764` / `0fbdefc` service-pools Phase 4 + T2 | **mine, PASS to merge dark** |
| `c6c502a` CI "baseline missing" | eta-refuter-2, PASS |
| `493bfb8` CI legacy shim | eta-refuter-2, PASS |

**It genuinely ships dark.** Grepping the whole tree for anything assigning `*_URLS`, `*_BULK_URLS`, `BULK_AGE_MINUTES` or `POOL_BULK_FALLBACK_LIVE` returns nothing. The pool exists and is unreachable by configuration, which is the state both refuters cleared it for.

**scribe is carrying the conditions into the train itself** — `3982d70` reads *"no `*_URLS`/`*_BULK_URLS` may be set (R1–R4 open)"* and `a30186c` *"still ships DARK (enabling awaits a ruling + measurement)"*. That matters more than it looks: a deploy condition recorded only in a verdict file does not travel with the code, and a `git log` is read by people who never open `docs/handoff`.

### FINDING — eight new settings, none in `.env.example`

`.env.example` is this repo's canonical flag documentation: **14,837 bytes, 109 variables**. The pool adds at least eight — `WHISPER_BASE_URLS`, `AUDIO_JOIN_URLS`, `DIARIZE_BASE_URLS`, `EMOTION_BASE_URLS`, their `_BULK_URLS` variants, the per-route `DIARIZE_EMBED_URLS` / `DIARIZE_VAD_URLS` / `DIARIZE_ENROLL_URLS`, plus `BULK_AGE_MINUTES` and `POOL_BULK_FALLBACK_LIVE`. **`.env.example` mentions none of them.**

This is a deviation from a convention the programme otherwise keeps — the VAD-trim branch added 11 lines to `.env.example` for its one flag.

**Why it is load-bearing here rather than merely untidy.** This feature's entire risk surface *is* someone setting an environment variable. Everything both refuters found — R1's unbounded pool, R2's route-404, my byte-identity and breaker-duration gaps, and the unvalidated twin parity — is harmless until a variable is set and dangerous the moment one is. The deploy condition currently lives in bus messages, two verdict files and two train commit messages. **The one place an operator looks immediately before setting a variable has nothing to say about it.**

The fix is the cheapest possible and puts the warning where the hand is: list the eight with a commented-out example and one line each saying they must not be set until twin parity is established and R3 is ruled. A verdict in `docs/handoff` does not reach someone editing environment variables at 3am; a comment beside the variable does.

## Verdict: PASS
Everything carries a verdict, the train ships dark and is verified to, and the conditions travel in the commit messages. The gap is that the warning is everywhere except beside the switch.
