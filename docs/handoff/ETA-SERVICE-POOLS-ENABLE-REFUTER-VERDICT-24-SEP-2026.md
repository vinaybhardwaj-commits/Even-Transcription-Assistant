# ETA — service-pools enable-blockers. REFUTER VERDICT (L9 primary). 24 Sep 2026

`vinay/service-pools-enable` **@ `e42b7e6`**, one commit on `5121764`. Worktree `/tmp/refute-spe`. `tsc --noEmit` **rc=0**; baseline **57/57** (was 40). **7 mutations, 7 killed, 1 void (mine, disclosed).**

## PASS — every code-level blocker is closed. Enabling still waits on two things that are not code.

### My two findings are closed

| mutation | at `5121764` | at `e42b7e6` |
|---|---|---|
| **N4** the single URL is trimmed (byte-identity) | survived | **killed** |
| **N5** `BREAKER_OPEN_MS` 5 min → 1 ms (breaker duration) | survived | **killed** |

### R1 is closed properly, and the subtle half is the one that matters

`runPool` now takes `budgetMs` — the client's own old timeout — and:

```ts
const deadline = start + opts.budgetMs;
const budget = i === 0 ? opts.budgetMs : deadline - now();
if (v !== "failover" || last || deadline - now() < floor) return finish(value, base);
```

**The first endpoint gets the whole budget.** That is what keeps the no-env call byte-identical while still bounding the pool: with one endpoint, the call gets exactly the timeout it always had. A naive fix would have divided the budget N ways and quietly shortened every single-endpoint call in production.

| mutation | result |
|---|---|
| **R1a** every endpoint gets a full budget — *the original bug re-introduced* | **killed** |
| **R1b** the first endpoint gets a share instead of all — *identity broken* | **killed, 3** |
| **R1c** the floor no longer stops failover | **killed, 2** |
| **R1d** `POOL_MIN_ENDPOINT_BUDGET_MS` 5 s → 0 | **killed, 2** |

R1a and R1b together are the pair worth having: one proves the bound exists, the other proves it was added without changing the unpooled path.

### R2 is closed structurally, not by a special case

Each eta-diarize route is its own pool — `diarize_embed`, `diarize_vad`, `diarize_enroll`, each with `inherit: "diarize"` so the old lists still work — and a route **404 is now failover** (`diarize.ts:44`, `enroll.ts:29`: `status >= 500 || status === 404 ? "failover" : "final"`). Mutating that back to `status >= 500` alone kills 2. A twin that does not serve a route no longer terminates the pool.

### A void mutation of mine, disclosed

My first R2 attempt replaced the string `404` in a **doc comment** at `diarize.ts:33`. The text changed, so my `git diff --quiet` applied-check passed it, and it "survived" — meaninglessly. That is exactly the trap split-speaker described to me yesterday: a mutation must change what the code *does*, not what it *says*. Redone against the real classifier, it kills. Not counted as a survivor.

## What still gates ENABLING, and neither is this branch's to fix

1. **R3 is proposed, not ruled.** The branch proposes that bulk work uses only `*_BULK_URLS` and never falls through to the live list, with `POOL_BULK_FALLBACK_LIVE=1` to allow it. That is the right default — the failure it prevents is the daytime backlog silently landing on the Mini when the twins are down — but it is Fable's ruling to make, and the branch correctly says so rather than assuming.
2. **Twin parity is still unestablished.** lab-mover's Phase 2 report still has one 120 s clip giving **153 words on gcp-l4 and 253–275 on c3 CPU**. Until that is diagnosed — my hypothesis remains a repetition loop on the CPU backend, testable by counting unique n-grams — setting `*_URLS` routes production STT to backends whose output is known to differ and not known to be correct. No amount of pool-level correctness fixes that; it is upstream of this code entirely.

## Verdict: PASS
Both refuters' code blockers are closed, and closed in the stronger form each time: a deadline that bounds the pool without shortening the unpooled call, per-route pools rather than a 404 special case, and my two untested guarantees now pinned. The remaining gates are a ruling and a measurement, not a defect.
