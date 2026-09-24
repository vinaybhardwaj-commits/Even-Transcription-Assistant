# ETA — REDUNDANCY-R1 Phase 4: service pools. REFUTER VERDICT. 24 Sep 2026

`vinay/service-pools` **@ `0fbdefc`** (builder lab-mover), on `train-24sep`. Lane L9. Worktree `/tmp/refute-sp`. `tsc --noEmit` **rc=0**; the four touched suites **121/121**. **8 mutations applied, 1 void (mine), 6 killed, 2 survived.**

## PASS-WITH-FIXES — the code is safe; *configuring* it is a separate decision that is not yet safe

### The safety case holds where it matters most

| mutation | result |
|---|---|
| **N2** `served_by` added even when the pool is unconfigured | **killed, 6** |
| **S1** a `final` answer (4xx, empty transcript) now fails over | **killed, 7** |
| **N1** all-breakers-open no longer tries anyway | **killed** |
| **N3** `served_by` leaks the full URL instead of the origin | **killed** |
| **N6** breaker threshold 3 → 999 (never opens) | **killed, 3** |
| **N7** breaker threshold 3 → 1 (opens on first failure) | **killed, 2** |

**The three-state verdict is the right design and arrived independently.** `ok` / `failover` / `final`, where a 4xx *or an empty transcript* is `final` because *"another endpoint would say the same"*. Treating an empty transcript as an **answer** rather than a failure is the load-bearing call: otherwise every silent window would be retried across the whole pool, multiplying cost and inviting a *different* backend to hallucinate text where the first correctly found none. That is the same ABSENT/BROKEN/OK rule eta-refuter-2 filed to the ledger last night, reached here by a different route.

**Two fail-safes worth naming.** `const order = live.length > 0 ? live : [...endpoints]` — all breakers open means try them all anyway, so a flaky pool never becomes "nothing was attempted" (N1). And `servedByOf` returns the **origin only**, never a path, query or userinfo, so a URL carrying credentials cannot be logged through the telemetry (N3).

**N6 and N7 together** make the threshold a pinned boundary rather than a present value — too high dies, too low dies.

### FINDING 1 — the byte-identity claim is half-tested

The header states the no-env guarantee precisely: `[<single>]` is used *"exactly as written (no trim, no normalising, so the no-env call is byte-identical)"*.

**N4 survives**: trimming the single URL (`single ? [single.trim()]`) leaves 40/40 green. So the `served_by` half of identity is pinned six ways over (N2) and the **URL-passthrough half is not pinned at all**. A future tidy-up adding `.trim()` or a normaliser would pass the suite while changing the exact call the no-env path makes — which is the one thing this branch promises it will not do. One assertion on a deliberately untidy value (`"  http://x:8080  "`) closes it.

### FINDING 2 — the breaker's threshold is pinned; its *duration* is not

**N5 survives**: `BREAKER_OPEN_MS` 5 min → **1 ms** leaves 40/40 green.

A breaker that opens for one millisecond is not a breaker. The consequence lands exactly where the breaker exists to help: with a genuinely dead endpoint, every call would retry it and pay a **full timeout** first — and *"each endpoint gets its own full timeout"* is a known limit the branch discloses. So the duration is what converts "we noticed it is dead" into "we stop paying for it", and nothing tests it. One assertion that a second call within the window skips the endpoint closes it.

### T2 — the join busy cap, 15 min → 6 h: justified, and it corrects my own earlier review

I passed `JOIN_BUSY_MAX_WAIT_MS = 15 min` at `5301fd7` yesterday. Production answered within a day: *"an operator batch put 67 room_window jobs in flight at once against a single-flight join, and 16 + 34 of them burned an attempt on `join_already_running` within the hour."* The 15-minute cap turned contention into failures.

**I verified that the cap was enforced; I did not ask whether it was calibrated.** D1–D5 at `5301fd7` checked that busy retries do not burn an attempt, that the caps exist and bound the loop, and that the cooldown is untouched — all true, and all beside the point that the number itself was too small for real contention. On `router_job_lost` I *did* do the arithmetic against the batch limit and found the bound too tight; here I did not, and the same class of error slipped through. Enforcement and calibration are different questions and I checked only the first.

The new value is reasoned rather than raised: busy is a queue, not a fault; a join still busy after 6 h is a wedged service and fails as before; the 2.5-minute per-claim budget still bounds each invocation. With a join pool, a busy instance hands off to the next before waiting at all.

### THE DEPLOY CONDITION — read before setting any `*_URLS`

**With no new env set this branch is inert** (N2 pins that, six tests). The moment `WHISPER_BASE_URLS` and friends are set, production STT is routed to the box, gcp-l4 and c3 twins.

**Those twins are not parity-validated.** lab-mover's own Phase 2 report (bus #55) records the same 120 s clip producing **153 words on gcp-l4 and 253–275 on c3 CPU**. I have put to them that this is very unlikely to be "not bit-stable" and much more likely to be a **repetition loop** on the CPU backend — the failure this programme has chased all week — and that the test is to count unique n-grams before any WER bar is set. Until that is resolved:

- Merging this is safe. **Setting the URLs is a different decision and does not yet have the evidence behind it.**
- Precedent: on 19 Sep the Yoga was ruled out as a diarize producer because arm64 and x86_64 diverge at speaker switches. Cross-backend divergence disqualified the substitute rather than being tolerated with a threshold.

## Verdict: PASS-WITH-FIXES
The pool logic is careful where carelessness would be expensive — identity when unconfigured, a final answer never retried, a flaky pool never silently skipped, and origins only in telemetry. Both findings are one assertion each. The real risk is not in this code: it is in the environment variables that switch it on, and the twins behind them are not ready.
