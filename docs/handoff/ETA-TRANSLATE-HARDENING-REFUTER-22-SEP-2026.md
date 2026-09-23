# ETA — router translate hardening. REFUTER VERDICT. 22 Sep 2026

`~/eta-router` **`cd62569`** (builder lx, `vinay/translate-hardening`), base **`ad4a7d8`** (live until 09:29 IST — see below). 2 files. Own detached worktrees `/tmp/refute-th`, `/tmp/refute-th-mut`; lx's worktree never written to, production `:8083`, its env, plist and ollama never touched. Probes ran in-process against a **local fake OpenRouter** (nothing left the Mini); the one real-data measurement read transcript text into a local process and printed **counts only**.

## PASS-WITH-FIXES

D1, D2, D4 and the allow-list all do what was asked, and D4 closes **real** production leaks. One finding: **D2's deadline, under the very condition it was built for, starves the healthy fallback.**

### D1 — FIXED

A list- or number-typed `content` now falls through as `openrouter_bad_response` (`isinstance` check), and a new shared `_call_backend` converts **any** backend exception to `unexpected:<Class>`, so nothing can raise out of `translate()`. Probed: both shapes reach the fallback. Mutations H1 (drop the `isinstance` check) and H2 (drop the generic `except`) each die **alone** — the belt and the braces are each tested.

### D2 — the deadline works, and fails the fallback under drip

Wall-clock deadline via `fut.result(timeout=…)`. The trickle fake (1 byte / 0.5 s, 1 s deadline) now fails at **1.01 s**, where `ad4a7d8` succeeded at 8.05 s. H3 (no deadline) and H4 (deadline 1000 s) die.

**FINDING — abandoned workers starve the fallback.** `requests` cannot be cancelled, so a call past its deadline keeps its worker until the upstream stops dripping. The pool holds 12 workers, and the fallback shares it. Production shape, slow primary, **healthy** fallback, 3 segments per window:

```
round 1-3: 3/3 translated via the fallback, 1.01 s      backend threads alive: 6, 10, 12
round 4:   0/3 translated, 2.02 s                        backend threads alive: 12
round 5:   0/3 translated, 2.02 s                        backend threads alive: 12
```

From round 4, every window's English is null **although the fallback model is healthy** — the case the fallback chain exists for. The healthy call is queued behind abandoned workers and cancelled at its own deadline, so it reports `openrouter_deadline` as though it had been slow. It **recovers** once the drips end (0.01 s after), and **no job hangs** — the requirement "fail on schedule, never wedge" is met. What is lost is the fallback's independence.

**Trigger:** only a server that sends bytes slowly — the same unverified condition D2 exists for. A silent slow model trips `requests`' own 60 s read timeout at about the deadline, so its worker exits on time and nothing accumulates.

**Fix, either:** close the socket at the deadline (`stream=True` with a wall-clock-checked read loop, or `httpx` with a total timeout), so no worker is abandoned; or give each engine its **own** pool, so a sick primary cannot exhaust the fallback's workers. H9 (drop `fut.cancel()`) survives unobserved — worth pinning with the fix.

### D4 — FIXED, and measured on real data

All 12 of my synthetic cases now decide correctly (**0 of 12 wrong**; the six that `ad4a7d8` leaked now translate; true English still skips).

**Real data, 364 windows, 24,439 segments, counts only:**

| | segments |
|---|---|
| skipped as English by `ad4a7d8` (live until 09:29) | 18,390 (75.2%) |
| now **vetoed** by `cd62569` → sent to the translator | **54** (0.2% of all) |
| `beta` the **sole** veto | **5** (0.020% of all segments) |
| `din` the sole veto | **0** |

**The pre-flagged false blocks are negligible**: at most 5 of 24,439, and a false block costs one call that returns English unchanged. **The veto is catching real leaks**: the 54 vetoed segments hit `hai` 25, `nahi` 10, `se` 9, `ke` 8, `ka`/`haan`/`bhi`/`ko` 7 each — so `ad4a7d8`, live until 09:29, was storing on the order of 54 romanised-Hindi segments per 24k as English, and this commit stops it, for **0.2% more translate calls**.

H5 (drop the veto) dies. H6 (drop `wahan`) survives because every case hits more than one token — the tests pin cases, not list membership, which is the right level.

### Override allow-list — FIXED

Allowed: the configured default, the fallback chain, `indictrans2`. Refused with `engine_not_allowed:…`: `ollama:qwen2.5:14b`, `openrouter:some/other-model`, and `OPENROUTER:A` (exact match). H7 (drop the check) and H8 (allow ollama) die. `translate_error` echoes up to 80 characters of the caller's string — untrusted input stored on a row, low severity.

## cd62569 is already LIVE

The order (09:25 IST) described production as `ad4a7d8`. During this review `~/eta-router` `main` was fast-forwarded to **`cd62569` at 09:29:42 IST** (`reflog: merge vinay/translate-hardening: Fast-forward`) and the router restarted at **09:29:43** (pid 96612). I did not do it; I never touched production. So the starvation finding is **live now**.

**No rollback recommended.** Reverting to `ad4a7d8` would reopen D1 (a malformed reply fails the job), D2 (unbounded call) and the ~54-per-24k romanised-Hindi segments `ad4a7d8` stores as English. `cd62569` is better on every measured axis; the starvation needs the unverified drip trigger, and even then no job hangs. Fix it next, on top of `cd62569`.

## Gate

`python -m unittest test_translate`: **61 passed**. Mutations: **7 of 9 killed** (H6, H9 survive, both explained above).

## Jev — run on the diff with none of my findings in its context

Scores **5.9–7.0**, all `low`, confidence 0.38–0.64.

- **reliability 6.4, "a race or concurrency assumption threatens reliable behaviour"** — **independent corroboration** of the starvation finding, raised without my telling it. This is the first time on these reviews Jev has independently pointed at the real defect.
- **observability 5.9 (lowest)** — **confirmed**: a starved fallback reports `openrouter_deadline`, indistinguishable from a genuinely slow model.
- **performance 6.2** — **confirmed as part of the same finding**: abandoned workers keep sockets open and keep reading.
- **consistency 6.3** — **confirmed, minor**: two codes now mean "timed out" (`openrouter_timeout` per read, `openrouter_deadline` wall clock); a reader counting timeouts needs both.
- **compatibility 6.4** — **rejected**: the only contract change is refusing non-allowed overrides, which is the requirement.
- **correctness 6.1** — no issue named; not counted.
