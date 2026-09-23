# ETA — routedChat overall deadline (F1). REFUTER VERDICT. 22 Sep 2026

`vinay/routedchat-deadline` **@ `15fd51b`** (builder fleet), one commit on `248c2ae`: `lib/llm/gemini.ts` and `tests/unit/routed-chat-deadline.test.ts`. It closes F1 from `ETA-QWEN-OUT-RELEASE-REFUTER-22-SEP-2026.md`. Contract: `weekA-2215.md` §fleet. Own detached worktrees `/tmp/refute-rcd` and `/tmp/refute-rcd-mut`; builder's worktree never written to, nothing pushed, no network call made to any real provider (every backend faked).

## PASS — one flag for Fable, no defect

**Every item in the order is met:** env override `ETA_ROUTED_CHAT_DEADLINE_MS`; default 1.5× the per-call timeout with the number justified in the code; in-flight calls aborted on expiry, not merely new ones skipped; the existing `RoutedChatResult` shape; the expiring stage logged by name; hanging-backend tests; the no-local-chat-model guard green.

**Mutations: 10 of 13 killed.** The default (D1 ×3, D2 ×1), the positive-only override (D3), the combined signal reaching both the Gemini and OpenRouter calls (D4, D5), the loop stopping on the deadline (D8), the caller-abort-mid-loop fix (D9), the bounded token wait (D11), the distinct `deadline_exceeded` error (D12) and the caller signal feeding the deadline (D13) all die.

- **D6 and D7 survive individually and are redundant guards, not a gap.** There are three deadline checks after the Gemini stage; removing either of these two leaves the others. Removing **both together** turns *"getVertexAccessToken itself hangs"* red — proven, not argued.
- **D10 (drop `clearTimeout` in the `finally`) survives** and is not observable at unit level: the orphaned timer only calls `abort()` on a finished call. Low.

### Gate — 7 failures under load, 0 in isolation

Full suite under the heavy lock: `Tests 7 failed | 3648 passed | 1 skipped`, at load ~36 (collect 447 s against 159 s on my previous run). **Six of the seven were `Test timed out in 5000ms`**, one was the known R58 flake, and one an `e11` assertion. **None of the six files references `lib/llm/gemini.ts` or `routedChat`.** Re-run on their own, one file at a time and under the lock so as not to add load: **`6 passed (6)`, `117 passed (117)`**, the `e11` assertion and R58 included. Load artefacts, not this branch. `typecheck` 0; `build ✓ 24.7s`.

### FLAG — the justified 1.5× is less forgiving than its justification says, in the case production uses

The code justifies 1.5× as *"enough for one stage to run its full declared timeout AND the next stage to still get a genuine, if truncated, attempt … one full hang is survivable."* That holds only for a fallback that answers in the **first half** of its own timeout — and only when the caller passes an explicit timeout.

**Two cases, because the per-stage timeouts differ:**

- **Caller passes no `timeoutMs`:** Gemini defaults to 240 s, each OpenRouter stage to 60 s, and the deadline is 1.5 × 240 = **360 s = 240 + 60 + 60 exactly**. All three stages get their full budgets. Fine.
- **Caller passes `timeoutMs = X`** (applied to *every* stage): the deadline is 1.5X. After a full first-stage hang, the first fallback gets **0.5X** and the **third stage can never run**.

**Nearly every production caller passes an explicit `timeoutMs`** — note generation, transcript cleanup, the CDMSS stub and pipeline, HyDE, the LLM surface tool, notegen analyze, the admin self-test. So the second case is the production case.

**Measured**, on fleet's own hanging-fetch pattern, with no override so the default applies: per-stage 200 ms, deadline 300 ms; Vertex hangs its full 200 ms; the first OpenRouter fallback would answer at **150 ms — inside its own 200 ms timeout** —

```
PROBE deadline=300ms perStage=200ms took=301ms ok=false error=deadline_exceeded:openrouter:google/gemini-3.8-flash provider=none
PROBE stages_hit=["vertex","openrouter"] llama_reached=false
```

A healthy fallback that would have succeeded is killed, and the third model is never tried.

**This is not a code defect** — 1.5× is the number the order specified, and fleet justified it. It is a consequence the justification understates, and the existing tests cannot show it: every deadline test sets `ETA_ROUTED_CHAT_DEADLINE_MS` to tens of ms against a 60 s per-stage timeout, so none exercises the **default** against a real stage hang. If Fable wants a hung Vertex to leave OpenRouter a full attempt, the default would need to be about 2× for two stages, or the fallbacks given their own budget rather than the caller's `timeoutMs`.

### Noted

- **The env override is not floored.** Fleet's ledger line says the deadline is *"never tighter than a single stage's own timeout"*; that is true of the **default** (tested for 1 to 999,999 ms) but the override is taken outright, so `ETA_ROUTED_CHAT_DEADLINE_MS=30000` would cut a 240 s Gemini stage at 30 s. Arguably what an operator setting it would want; worth saying so in the comment.
- **The token fetch is not cancelled**, only no longer waited on — the builder's own named limitation, confirmed by reading `raceSignal`.

## Jev (V's standing rule) — after my read, rerun and mutations; neutral context

Task, source diff and neutral context only. Scores **7.2–8.6**, all `low`, confidence 0.41–0.79 — the strongest scores of tonight's branches.

- **compatibility 7.6** ("appears to break an existing integration contract") → **REJECTED after checking**: the result shape is unchanged, and I searched for callers that branch on `routedChat`'s `error` string — none do (the `"aborted"` matches are other modules' own values), so the new `deadline_exceeded:<stage>` cannot be misread.
- **correctness 7.6** ("an important edge case appears insufficiently handled") → **CONFIRMED in substance**: it is the FLAG above. Jev named no case; the explicit-timeout arithmetic and the probe are mine.
- **observability 7.2** ("a service boundary lacks an outcome signal") → **partly confirmed, low**: the expiring stage is logged as ordered, but the background token fetch that outlives the deadline is invisible — the builder's named limitation.
- **reliability 7.6** ("a race or concurrency assumption") → **CONFIRMED as the documented limitation** (token fetch keeps running), nothing beyond it.

**Verdict: PASS.** The deadline bounds the chain, aborts in-flight calls, keeps the result shape and names the stage. The flag is Fable's call: whether 1.5× is the bound wanted once it is clear that, for every caller that passes a timeout, a hung Vertex costs the fallback half its time and the third model entirely.
