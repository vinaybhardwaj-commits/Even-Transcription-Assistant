# ETA — routedChat deadline round 4. REFUTER RE-CHECK. 23 Sep 2026

`vinay/routedchat-deadline` **`acc56cd` → `3a7ca76`** (builder fleet), one commit: `lib/gcp-auth.ts`, `lib/llm/gemini.ts` and their two tests. Promotes the round-3 NOTE to work on Fable's ruling, and folds in both round-3 trivia. Own detached worktree `/tmp/refute-rcd4`; nothing pushed, no real provider called. Mini kept out — every run on the Yoga fast runner.

## PASS — the sum is now honest about everything the call awaits

### The r3 note is closed at the level it was raised

The mint was an awaited stage the sum did not count, paid out of the 10% skew allowance. It now has its own budgeted line: `MINT_TIMEOUT_MS = 10_000` is **both** counted in `routedChatDeadlineMs` **and** passed to `getVertexAccessToken` at both call sites, so the arithmetic and the runtime agree — which is precisely the failure shape of round 2, one level up, fixed the same way. `lib/gcp-auth.ts` now builds its own `AbortController` and timer, combines any external signal into it, and clears the timer in `finally`; the cached fast path still returns before `fetch`.

Both round-3 trivia are genuinely collapsed, not papered over: `fallbackBudgetMs()` is one helper used by the sum **and** the actual `openrouterChat` call, and `routedChat` resolves `llmFallbackModels()` **once** at `:292`, passes that array's length into the deadline at `:293`, and iterates **that same array** at `:337`.

### Mutations — 9 of 12 killed, 0 runner errors

Every load-bearing part dies: the mint in the sum (**W1**), the mint's budget at each call site (**W2**, **W3**), `MINT_TIMEOUT_MS`'s *value* and not merely its presence (**W4**), gcp-auth's own timer (**W5**), gcp-auth still honouring an external signal (**W6**), the fallback call using the shared helper (**W8**), the helper being a `min` not a `max` (**W9**), and the 10% slack (**W12**).

**Three survivors, and the builder predicted all three. Two of those predictions are right and one is not.**

- **W7 — `clearTimeout(tid)` removed, survives.** A dangling timer that later aborts an already-settled controller: functionally harmless, but it holds a live handle for up to its full budget, which on a serverless instance can delay freeze. Established class — the same `clearTimeout` mutant survived in round 1 as D10. Untested, one line.
- **W10 — passing the resolved length into the deadline, survives, and is a TRUE equivalent mutant.** I verified rather than accepted: `:292` and `:293` are **adjacent synchronous statements**, so `llmFallbackModels()` and the default `llmFallbackModels(env).length` cannot observe different values. Nothing to test; the builder's framing is exactly right here.
- **W11 — iterating the resolved array, survives, but is NOT equivalent in the same sense.** The builder grouped all three as "equivalent under any reachable test today, so the fix is provable single-source-of-truth, not a behavior change." For W10 that is correct. For W11 it understates the fix: `:337` is separated from `:292` by **two awaits** (`:313` the mint, `:314` the primary call) which together can span the caller's entire `timeoutMs` — up to 240 s for note generation. `process.env` is process-global, so a re-read at `:337` is a read-after-await against a mutable global, where `:293`'s is not. It is unobservable today because nothing mutates `LLM_FALLBACK_MODELS` mid-process, and I am not claiming a live bug. But the fix closes a real window at `:337` that never existed at `:293`, and that is a better reason to keep it than "provably the same number".

## The symmetric cost of budgeting a stage — measured, and reported because it is real

Giving the mint a budget means it can now **fail on its own budget** where before it could borrow from the rest. That is the correct trade and I asked for it; it is not free, and the two callers pay differently:

- **`routedChat`** — a mint timeout is caught at `:323`, pushes `gemini:threw`, and **the OpenRouter chain still runs**. Graceful degradation.
- **`geminiChatIfOn`** — Gemini-only by design (fusion, live translate), so the same timeout returns `gemini_threw` with **no fallback**. Worth stating in full rather than as a complaint: before r4 that call site was bounded by *nothing at all* — I established in round 2 that neither `fuse-transcript.ts:67` nor `translate-live/route.ts:57` passes a signal — so r4 converts "hangs forever" into "fails at 10 s". Better on balance. The residue is that a mint taking 10–30 s, which would previously have completed, now fails those two surfaces.

**And the deadline grows by exactly 11 s for every caller, cached token or not:**

| caller | `timeoutMs` | r3 deadline | r4 deadline | backstop ÷ caller's own timeout |
|---|---|---|---|---|
| `CLEANUP_TIMEOUT_MS` | 8 s | 26.4 s | **37.4 s** | **4.7×** |
| `HYDE` / `SURFACE` | 10 s | 33.0 s | 44.0 s | 4.4× |
| admin self-test | 45 s | 148.5 s | 159.5 s | 3.5× |
| `CDS_TIMEOUT_MS` | 60 s | 198.0 s | 209.0 s | 3.5× |
| `NOTE_TIMEOUT_MS` | 240 s | 396.0 s | **407.0 s** | 1.7× |

This is **correct, not a defect** — a deadline must cover what can actually run, and it binds only when every stage hangs; the caller's own `timeoutMs` still governs the normal case. It is worth recording because it is the exact inverse of the round-3 finding: there the small callers were *starved* by an uncounted stage, here they are the ones whose backstop now sits furthest from their stated intent.

### NOTE — `MINT_TIMEOUT_MS` is uncalibrated, and there are two numbers for one operation

`MINT_TIMEOUT_MS = 10_000` (gemini.ts) and `MINT_DEFAULT_TIMEOUT_MS = 30_000` (gcp-auth.ts) budget the **same** operation — one RSA sign plus one OAuth exchange — and differ by 3×. The 30 s is justified only as "generous, since a caller that cares always passes its own budget", and the 10 s carries no stated basis at all. Neither is wrong; both are guesses, and 10 s is now the one number that can turn a slow-but-working mint into a failed fusion or live-translate call.

Cheap and in the repo's idiom: log the mint's elapsed time when it exceeds some fraction of its budget, so the value can be **calibrated from production rather than argued**. That is the same move that settled the encounter-clock floor question — measure the thing, then choose the constant.

Two further callers, `lib/stt/adapters/gemini.ts:278,349`, pass neither argument and so take the 30 s default. That is a **strict improvement**: in that adapter the mint runs at `:278`, *before* the adapter's own `AbortController` is created at `:283`, so it was previously unbounded there too.

## Jev (V's standing rule) — after my read, rerun and mutations; r3's result passed as `previousEvaluation`

Neutral context, none of my findings, no mention of the mint's calibration. Scores **7.0–7.9**, all `low`.

**The deltas are the signal, and they land on the three things r3 actually found:** `reliability` **7.2 → 7.5** (r3's "timeout behaviour disproportionate", which *was* the uncounted mint), `testQuality` **6.7 → 7.1**, `duplication` **7.7 → 7.9** (the collapsed `Math.min`), `correctness` **7.1 → 7.4**. Independent corroboration that the fixes landed where they were aimed.

- **`documentation` 8.0 → 7.0, the single regression, and Jev's only one** ("a non-obvious decision lacks an explanation of why") → **CONFIRMED, and it is the NOTE above**, which I wrote before seeing this score. Two constants for one operation, 10 s and 30 s, neither with a stated basis. The commit message explains the *mechanism* at length and the *numbers* not at all.
- **`correctness` 7.4, its top priority** ("an important edge case insufficiently handled") → **partly CONFIRMED**: the `geminiChatIfOn` no-fallback path above. Not a defect, a trade.
- **`changeability` 7.6** ("a domain rule scattered across locations") → **CONFIRMED, narrow**: the two mint constants again, in two modules.
- **`maintainability` 7.3** ("failures would be difficult to isolate") → **fair**: a mint timeout surfaces as `gemini:threw`, indistinguishable in the log from a model failure. The same class as the r3 observability point, and the logging suggestion above would fix both at once.

## Gate

- **Mine:** 12 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `3a7ca76` afterwards.
- **The builder's, quoted as theirs:** full suite green on the Yoga; their own mutation check of the mint removal and both call sites agrees with my W1–W3. They also fixed a genuinely-deterministic unhandled rejection the Yoga gate caught (a fake-timer promise rejected by `advanceTimersByTimeAsync` before `rejects.toThrow()` attached a handler), verified across five repeated runs — worth noting because it was diagnosed as deterministic rather than dismissed as flake.

**Verdict: PASS.** Three rounds of the same defect — an arithmetic promise the runtime did not keep — are now closed at every level: the fallback's budget, the stage count, and the mint's own line. The remaining items are a one-line `clearTimeout`, and two uncalibrated constants that should be measured rather than defended.
