# ETA — mint budget follow-up, the fixes. REFUTER RE-CHECK. 23 Sep 2026

`vinay/mint-budget-followup` **@ `2852d84`** (builder fleet), one commit on `1686171`, **tests only** — `gcp-auth-abort.test.ts`, `routed-chat-deadline.test.ts`, `routed-chat-fallback.test.ts`. Re-check of the four findings in `ETA-MINT-BUDGET-FOLLOWUP-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktree `/tmp/refute-m2`, HEAD asserted as `2852d84` before the run. Nothing pushed, no real provider called. Mini kept out — every run on the Yoga fast runner.

Tests only is the right shape: all four findings were coverage gaps, not defects in the source.

## PASS — all four closed, and the strongest fix was taken

**Mutations: 7 run, 0 runner errors, 6 killed.** Every one of my findings now dies:

| my finding | mutation | before | now |
|---|---|---|---|
| **FINDING 1** — the constant was un-pinned by the mock | `MINT_TIMEOUT_MS` 10 000 → 100 000 | survived | **killed** |
| **FINDING 2** — the calibration log untested | the log never fires | survived | **killed** |
| **FINDING 2** — its key and payload | log becomes `"mint done"` | survived | **killed** |
| **FINDING 3** — "one budget" unpinned | back to `?? 30_000` | survived | **killed** |
| **FINDING 4** — the sibling timer | `clearTimeout` in `gemini.ts` | survived | **killed** |
| control | `clearTimeout` in `gcp-auth.ts` (W7) | killed | **killed** |

**Finding 1 was fixed with `importOriginal`, which was the better of the two options I offered and closes the class rather than the instance.** The mock now spreads the real module and overrides only `getVertexAccessToken`, so it can no longer restate *any* export as a literal. That the value mutation now dies is the proof the mechanism works, not just that one assertion was added — and the comment records that an earlier version of the mock did exactly the thing being prevented, which is the right thing to leave for the next reader.

## NEW — the token cache is untested, and two rounds of reasoning rest on it

**QN survives.** Inverting the cache's early-refresh comparison —

```
lib/gcp-auth.ts
-  if (cached && cached.expiresAt - 5 * 60_000 > now) return cached.token;
+  if (cached && cached.expiresAt - 5 * 60_000 < now) return cached.token;
```

— leaves the whole suite green. The mutant is not subtle: it serves the cached token **only once it is within five minutes of expiry or already past it**, and mints a fresh one on every call while the cached one is still good. That is both a cache that never helps and a token that goes stale exactly when it matters.

This is **not** an `importOriginal` failure — Q6 dying proves the real module's exports now reach the tests. It is simply that nothing asserts the caching behaviour at all, and my probe happened to walk into it.

**Why it is worth more than a routine missing test.** The last two rounds' reasoning depends on this line being right. The r4 verdict accepted an 11-second deadline growth for every caller *because* "the token is cached for about an hour, so the mint is a cold-start cost rather than a per-call one". The r5 calibration log is documented as recording "every actual (non-cached) mint", and its usefulness assumes cached calls are the common case. If this comparison were ever inverted, every call would mint, the 10 s budget would be paid on every request rather than on a cold start, and the calibration log's distribution would silently become a different population — all without a single test failing.

The cache is the load-bearing assumption under two accepted trade-offs, and it is the one part of this file with no coverage. **Fix:** two assertions in `gcp-auth-abort.test.ts`, which already drives the real module — a second call within the window does not re-fetch, and a call inside the five-minute margin does.

## Gate

- **Mine:** 7 mutations through the Yoga fast runner, 0 runner errors, worktree HEAD asserted before the run and verified clean after.
- **The builder's:** as recorded on the branch; I did not re-run the full suite for a tests-only change.

**Jev — not run.** A tests-only diff closing findings whose source Jev scored last round; the server's guidance is against repeating a call on effectively the same change, and the mutation table answers the question directly.

**Verdict: PASS.** All four findings are closed, and Finding 1 was closed at the class rather than the instance — the mock can no longer drift from the module for any export, which is what I asked for and more than the minimum. The new item is not a regression and not this commit's doing: it is a pre-existing gap my probe surfaced, in the one line that two rounds of accepted trade-offs quietly depend on.
