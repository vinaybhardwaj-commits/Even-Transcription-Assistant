# ETA — routedChat deadline round 2. REFUTER RE-CHECK. 23 Sep 2026

`vinay/routedchat-deadline` **`15fd51b` → `99fddcf`** (builder fleet), two commits: `4c239db` (per-stage budgets, on Fable's ruling on my flag) and `99fddcf` (an AbortSignal for the token exchange). Own detached worktree `/tmp/refute-rcd2`; builder's worktree never written to, nothing pushed, no real provider called.

## PASS-WITH-FIXES — the flag is closed for five of six callers and survives for the sixth: note generation

**Gate, on the Yoga runner:** `Test Files 164 passed (164)`, `Tests 3663 passed | 1 skipped (3664)`, **0 failed**; `build ✓ Compiled successfully in 13.9s`; 279 s wall.

### What the new rule fixes — confirmed

`deadline = (primary + 2 × fallback) × 1.10`, where `primary` is the caller's `timeoutMs` (or 240 s) and `fallback` is `min(timeoutMs, 60 s)`. On the exact case I measured in round 1 — `timeoutMs = 200 ms`, primary hangs its full 200 ms, a fallback that would answer at 150 ms — the deadline is now **660 ms** against a worst case of 200 + 200 + 200 = 600 ms, so all three stages get their full budgets and the healthy fallback is no longer killed. Their own test pins it (`routedChatDeadlineMs(200) === 660`).

### `99fddcf` — the former limitation is genuinely closed

`getVertexAccessToken(signal?)` now wires the signal into its own token-exchange `fetch`, so the deadline cancels that call instead of merely abandoning it; the parameter is optional and additive, so existing callers are unchanged, and the cached-token path never reaches `fetch` anyway. `raceSignal` is deliberately kept as a redundant second guard — explicitly on the D6/D7 reasoning from my round-1 verdict, which is the right reading of it. The stale "KNOWN LIMITATION" comment is corrected rather than left behind.

### FIX — the budget is arithmetic only; a fallback still receives the caller's whole timeout

`routedChatDeadlineMs` budgets a fallback at `min(timeoutMs, 60 s)`, but the fallback is still **called** with `timeoutMs: p.timeoutMs` (`lib/llm/gemini.ts:294`). Nothing bounds a stage to its budget at runtime — only the sum is enforced — so the arithmetic's premise is false for any caller whose `timeoutMs` exceeds 60 s.

Working it through: with caller timeout **T**, `deadline = 1.1T + 132 s`. A fully hung primary consumes T, leaving `0.1T + 132 s`; the first fallback may consume all of that, because its own timeout is T rather than 60 s. The second fallback is therefore unreachable once `T ≳ 147 s`:

| caller `timeoutMs` | deadline | left after a hung primary | second fallback gets |
|---|---|---|---|
| 25 s | 82.5 s | 57.5 s | 32.5 s |
| 60 s | 198.0 s | 138.0 s | 78.0 s |
| 120 s | 264.0 s | 144.0 s | 24.0 s |
| **240 s** | **396.0 s** | **156.0 s** | **0 s — unreachable** |

**The callers**: `CLEANUP_TIMEOUT_MS` 8 s, `HYDE_TIMEOUT_MS` 10 s, `SURFACE_TIMEOUT_MS` 10 s, an admin self-test 45 s, `CDS_TIMEOUT_MS` 60 s — all clear. **`NOTE_TIMEOUT_MS = 240_000`** (`lib/note-generation.ts:24`, passed at `:550`) is not: clinical note generation, the highest-value call in the product, still loses its second fallback entirely when Vertex and the first OpenRouter model both hang. That is the round-1 flag, for the one caller it matters most for.

**Fix, one line:** pass the fallback its budget — `timeoutMs: Math.min(p.timeoutMs ?? FALLBACK_STAGE_CAP_MS, FALLBACK_STAGE_CAP_MS)` on the `openrouterChat` call — which makes the runtime match the arithmetic and brings note generation's worst case to 240 + 60 + 60 = 360 s inside a 396 s deadline. A test that asserts the timeout each stage is *given* (not only the deadline) would pin it.

### Second, smaller instance of the same class

`FALLBACK_STAGE_COUNT` is fixed at 2 while `llmFallbackModels()` reads a configurable `LLM_FALLBACK_MODELS`. A list of three models would still be budgeted as two, so the third would be unreachable by construction. The builder documents this in the constant's comment; it is a knob that can silently invalidate the sum, and deriving the count from the list would remove the trap.

### Mutations

**Run on 23 Sep once the runner was fixed — see the addendum at the foot of this file: 13 mutations, 11 of 12 killed in the main set, 0 errors, and the one survivor is this commit's own wiring (untested at both call sites, because the gcp-auth mock is zero-arity).** Round 1's 13 mutations against `15fd51b` killed 10, with D6/D7 (mutually redundant guards) and D10 (`clearTimeout`) surviving as established.

## Jev (V's standing rule) — after my read and rerun; neutral context

Task, diff and neutral context; none of my findings. Scores **6.3–7.6**, all `low`.

- **correctness 6.3, its top priority** ("the implementation appears to rely on an unsafe or incorrect assumption") → **CONFIRMED, and it is the FIX above**: the deadline assumes a fallback consumes at most 60 s while the code hands it the caller's full timeout. Jev named no specifics; the caller table and the 147 s threshold are mine.
- **duplication 6.6** ("knowledge that should change together is represented independently") → **CONFIRMED, and it caught a second instance I had not stated**: the fixed `FALLBACK_STAGE_COUNT` against the configurable model list.
- **changeability 6.9 / maintainability 6.6 / reliability 7.0** → **same root**: a budget expressed as a constant that the runtime does not enforce.
- **compatibility 7.2, documentation 7.6** → no action; the result shape is unchanged and the rationale is written out at length.

**Verdict: PASS-WITH-FIXES.** Per-stage budgets are the right shape and they close the case I measured, and the token-exchange gap is genuinely closed. The remaining fix is one argument: until a fallback is called with its own budget, the sum is a promise the code does not keep, and note generation at 240 s is the caller that pays.

---

# Addendum — mutations, 23 Sep (runner fixed)

Run against `99fddcf` through `yoga-test.sh --mutate`, 13 mutations, **0 errors**. **11 of 12 killed** in the main set, plus one targeted probe at the sibling call site which also survived.

**Everything the arithmetic rests on is pinned.** `routedChatDeadlineMs` dies on all five of its parts — the per-stage sum (replacing it with the old `primary × 1.5`), the `min(timeoutMs, 60 s)` cap, `FALLBACK_STAGE_COUNT = 2`, the 10% slack, and the explicit-override branch. So do the deadline plumbing mutants: the signal reaching `openrouterChat`, the distinct `deadline_exceeded:<stage>` error, the mid-loop caller-abort shape, and the loop's stop-on-deadline. `raceSignal` itself is pinned (E8 dies), which is worth saying next to D6/D7 from round 1: the wrapper is not the redundant half — the call-site argument is.

### The one survivor is `99fddcf`'s own wiring — at both call sites

- **E7 — `getVertexAccessToken(signal)` → `getVertexAccessToken()` in `routedChat` (`lib/llm/gemini.ts:270`) survives.**
- **E13 — the same edit at `geminiChatIfOn` (`:108`) survives.**

The commit's own test, `gcp-auth-abort.test.ts`, is sound and has teeth: removing `signal` from the token-exchange `fetch` inside `lib/gcp-auth.ts` **kills** (E6). What is untested is whether `gemini.ts` ever *passes* one. The reason is one line:

```
tests/unit/routed-chat-deadline.test.ts:16
vi.mock("@/lib/gcp-auth", () => ({ getVertexAccessToken: () => gcpMock.getToken() }));
```

A zero-arity mock discards the argument, so no test in the gemini suite can observe it. `routed-chat-fallback.test.ts` and `gemini-stt.test.ts` mock the module the same way. The follow-up commit proves the callee honours a signal and never that the caller sends one — the two halves of the fix are tested on opposite sides of a mock that cannot see the join.

**What each would cost, stated plainly and separately:**

- At **`routedChat`**, `raceSignal` still returns promptly, so a regression would not hang the caller; it would leave the token-exchange socket open until its own timeout — exactly the leak `99fddcf` was written to close, reopened invisibly. This is the same shape as D6/D7: a redundant guard makes the new behaviour unobservable, so nothing fails when it is removed.
- At **`geminiChatIfOn`** there is **no** `raceSignal`, so the same omission would be an unbounded await on a hung token mint. **Inert today**: neither caller passes a signal — `fuse-transcript.ts:67` and `translate-live/route.ts:57` pass `timeoutMs` only, and the admin self-test is trivial. The parameter is on the function's contract and unused, so this is a trap set for the first caller that uses it, not a live fault.

**Fix, one line plus one assertion:** give the mock its argument — `getVertexAccessToken: (signal?: AbortSignal) => gcpMock.getToken(signal)` — and assert in the existing deadline test that the recorded signal is the deadline's. That kills E7 and E13 together.

**Not re-run:** Jev. The diff is unchanged from the one scored in this verdict, and the server's own guidance is not to repeat an identical call; the mutation evidence above is independent of it.
