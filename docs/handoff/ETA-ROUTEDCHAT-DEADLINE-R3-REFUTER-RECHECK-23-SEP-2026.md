# ETA — routedChat deadline round 3. REFUTER RE-CHECK. 23 Sep 2026

`vinay/routedchat-deadline` **`99fddcf` → `acc56cd`** (builder fleet), two commits: `b57506a` (the zero-arity `gcp-auth` mock my re-check addendum found) and `acc56cd` (the per-stage budget enforced at runtime, and the stage count derived from the chain). Own detached worktree `/tmp/refute-rcd3`; builder's worktree never written to, nothing pushed, no real provider called.

## PASS — both round-2 findings are closed, and both are mutation-pinned

### FIX 1 — the fallback now receives its own budget

The r2 verdict's open item was that `routedChatDeadlineMs` budgeted a fallback at `min(timeoutMs, 60 s)` while the stage was still *called* with `p.timeoutMs`, so the sum was a promise the runtime did not keep. `routedChat` now computes `fallbackTimeoutMs = Math.min(p.timeoutMs ?? FALLBACK_STAGE_CAP_MS, FALLBACK_STAGE_CAP_MS)` and passes it, using the **same exported constant** the arithmetic uses rather than a second literal. Note generation's worst case is now 240 + 60 + 60 = **360 s inside a 396 s deadline**, so the second fallback is reachable — the exact case my r2 table showed as unreachable.

### FIX 2 — the stage count follows the chain

`FALLBACK_STAGE_COUNT = 2` is gone; the count is `llmFallbackModels(env).length`. A three-model `LLM_FALLBACK_MODELS` is now summed as three. This was the smaller instance of the same class that Jev's `duplication` lead surfaced in r2 and that I had not stated myself.

### FIX 3 — the mock that hid the wiring

`b57506a` gives the `gcp-auth` mock its parameter and records the signal:

```
vi.mock("@/lib/gcp-auth", () => ({
  getVertexAccessToken: (signal?: AbortSignal) => { gcpMock.lastSignal = signal; return gcpMock.getToken(signal); },
```

That closes the blind spot from my r2 addendum, where the two halves of the `99fddcf` fix were tested on opposite sides of a mock that could not see the join.

### Mutations — 11 of 11 killed, 0 runner errors

Both new fixes die (G1: handing the fallback `p.timeoutMs` again; G2: hardcoding the count at 2), and so does every guard around them — the runtime cap being a `min` not a `max`, the 60 s cap value, the deadline's own `min`, the fallbacks being counted at all, the 10% slack, the env override, the deadline signal reaching the fallback call, and the deadline function reading its passed `env`.

**G9 — `getVertexAccessToken(signal)` → `getVertexAccessToken()` — now dies.** That was the sole survivor of my r2 addendum, at both call sites; the mock fix closed it. Nothing is left open from round 2.

## NOTE — a third instance of the same class, one level up: the token mint is not in the sum

Not a blocker, and deliberately reported as smaller than the r2 finding it resembles.

The sum budgets `primary = p.timeoutMs`, and that is the timeout handed to `openaiChat`. But the primary **stage** is two sequential awaits:

```
lib/llm/gemini.ts:277-281
const token = await raceSignal(getVertexAccessToken(signal), signal);   // no timeout of its own
const r = await openaiChat({ …, timeoutMs: p.timeoutMs, signal });      // budgeted
```

`getVertexAccessToken` does an RSA signing step and an OAuth `fetch` carrying **only `signal`** — no `timeoutMs` (`lib/gcp-auth.ts:42-57`). It is therefore bounded only by the overall deadline, and its time is paid out of the 10% slack. The builder's own comment states the principle it sits outside: *"The 10% slack absorbs `Date.now()` skew … it is not meant to cover a stage the sum did not already count."*

Worst case is `mint + primary + count × fallbackBudget` against a deadline of `1.10 × (primary + count × fallbackBudget)`, so the last fallback is starved once the mint exceeds the slack:

| caller | `timeoutMs` | deadline | slack the mint must fit in |
|---|---|---|---|
| `CLEANUP_TIMEOUT_MS` | 8 s | 26.4 s | **2.4 s** |
| `HYDE` / `SURFACE` | 10 s | 33.0 s | 3.0 s |
| admin self-test | 45 s | 148.5 s | 13.5 s |
| `CDS_TIMEOUT_MS` | 60 s | 198.0 s | 18.0 s |
| `NOTE_TIMEOUT_MS` | 240 s | 396.0 s | 36.0 s |

**The inversion is worth naming:** in round 2 note generation was the victim, because the fault scaled with the caller's timeout. Here it is the opposite — the slack scales with the caller too, so the *smallest* callers are tightest, and `llm-cleanup` at 8 s has 2.4 s to cover clock skew **and** a cold token exchange together.

**Why this is a note and not a fix.** It needs a cold mint *and* a hung primary *and* both fallbacks to matter. The token is cached for ~1 h with a 5-minute early refresh (`lib/gcp-auth.ts:12,44`), so the mint is a cold-start cost, not a per-call one, and a warm call never reaches `fetch` at all. Round 2's finding was unconditional arithmetic; this one is conditional on a slow network at exactly the wrong moment. **Fix when convenient, one line either way:** add the mint to the sum, or give it its own small `timeoutMs` so it cannot spend another stage's slice.

### Two smaller notes

- **The cap expression is duplicated, though the constant is not.** `Math.min(x ?? FALLBACK_STAGE_CAP_MS, FALLBACK_STAGE_CAP_MS)` is written out in both `routedChatDeadlineMs` and `routedChat`. Sharing the constant was the right half of the fix; a tiny `fallbackBudgetMs(timeoutMs)` helper would make the two provably the same rather than textually identical. Jev's `duplication` 7.7 points at this.
- **A latent env asymmetry.** `routedChatDeadlineMs` counts with `llmFallbackModels(env)` while `routedChat`'s loop iterates `llmFallbackModels()`. In production both read `process.env` at the same moment, so they agree and there is no defect; the `env` parameter exists for tests. Worth one comment so a future caller passing a custom `env` does not budget one chain and run another.

## Jev (V's standing rule) — after my read, rerun and mutations; neutral context

Task, source diff and neutral context; none of my findings, and no mention of the token mint. Scores **6.7–8.1, all `low`** — up from 6.3–7.6 on r2 of this same branch, which is the clearest corroboration that the fixes landed.

- **reliability 7.2** ("timeout or retry behaviour is missing, unsafe, or disproportionate") → **CONFIRMED, and it is the NOTE above**: an awaited stage with no timeout of its own inside a summed budget. Jev named no specifics; the slack table and the caller inversion are mine.
- **testQuality 6.7, its top priority** ("important changed behaviour lacks meaningful regression coverage") → **partly REJECTED**: the fake-timer tests over the 240 s shape are good and my 11 mutations all died, so the changed behaviour *is* covered. What is not covered is the token mint's share — the same gap as the NOTE, not a separate one.
- **duplication 7.7** ("the same rule in multiple places") → **CONFIRMED, minor**: the duplicated `Math.min` expression.
- **correctness 7.1** ("an important edge case insufficiently handled") → **CONFIRMED in substance**, same root.
- **changeability 7.8, documentation 8.0** → no action; the rationale is written out at length and the constants are now single-sourced.

## Gate

- **Mine:** 11 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `acc56cd` afterwards.
- **The builder's, quoted as theirs:** gate green, 3,668 passed on the Yoga (per Fable's order); their own mutation check of 2/2 on the new fixes agrees with my G1/G2.

**Verdict: PASS.** Round 2 is fully closed — both fixes are correct, single-sourced, and mutation-pinned, and the mock repair kills the one survivor I left open. The remaining item is a note of the same family one level up: the deadline sums the stages it knows about, and the token mint is a stage it does not know about.
