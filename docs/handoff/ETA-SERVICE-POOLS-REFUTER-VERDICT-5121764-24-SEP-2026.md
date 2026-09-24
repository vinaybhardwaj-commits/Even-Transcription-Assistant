# ETA — service pools @ 5121764. REFUTER VERDICT (L9 primary). 24 Sep 2026

`vinay/service-pools` **@ `5121764`**, 2 commits on production `0e96d39`. Supersedes my verdict on `0fbdefc`. Worktree `/tmp/refute-sp2`.

**The delta from `0fbdefc` is 2 test files, +3/−2.** The SOURCE IS IDENTICAL to the head I reviewed and mutated, so every result in `ETA-SERVICE-POOLS-REFUTER-VERDICT-24-SEP-2026.md` carries forward unchanged: `tsc` rc=0, 121/121 on the touched suites, 8 mutations, 6 killed, 2 survived. split-speaker fixed two of their own tests that `0fbdefc` failed; nothing I tested moved.

## VERDICT: PASS TO MERGE DARK — NOT CLEARED TO ENABLE

That is the same split eta-refuter-2 reached independently ("PASS to ship DARK, FAIL to ENABLE"), and scribe can merge on it.

### Why merging is safe

**N2 kills 6 tests**: with no new env set, no `served_by` key and no changed call. The no-env identity is the whole safety case for merging and it is the best-pinned property in the branch. Add `tsc` rc=0, the box gate green (204/204 files, 4,519 passed), and scribe's clean trial merge onto `train-24sep-pm a13de59`.

### Why enabling is not cleared — three independent reasons

**1. R1 (eta-refuter-2's, and it is right — I verified it and I had missed it).** `runPool` has **no cross-endpoint deadline**: grep for deadline / AbortController / budget / elapsed in `lib/service-pool.ts` returns nothing. `lib/whisper.ts:330` is `timeoutMs ?? 90_000` per call, and the pool tries endpoints in sequence, so wall time is N × the per-call timeout. Against a 300 s `maxDuration` a diarize failover cannot finish inside one invocation: it is killed mid-flight and the dispatched call is orphaned server-side — double work, and for pyannote.ai double paid spend.

The corroboration is inside the codebase: `lib/jobs/runner.ts:160` already reasons that *"3 × MAX_STEP_MS is 600 s against a 240 s lease"*, and `:183` breaks on a deadline. **The runner has a budget; the pool does not participate in it.**

**I had this in front of me and did not act on it.** The branch's own "Known limits" says *"each endpoint gets its own full timeout"*. I recorded it as disclosed and moved on. Disclosure describes a limit; only arithmetic decides whether it is safe. That is the second time today I verified a bound was *enforced* without asking whether it was *calibrated* — the join cap being the first, which production corrected within a day. One lesson, twice, in one session.

**2. My two findings, unchanged at this head.** N4: the header promises the no-env call is byte-identical, *"no trim, no normalising"*, yet trimming the single URL leaves 40/40 green — the `served_by` half of identity is pinned six ways and the URL-passthrough half not at all. N5: `BREAKER_OPEN_MS` 5 min → 1 ms leaves 40/40 green, so the breaker's **duration** is untested while its threshold is pinned both ways — and duration is what converts "we noticed it is dead" into "we stop paying a full timeout for it", which is exactly R1's cost multiplied.

**3. The twins are not parity-validated.** lab-mover's own Phase 2 report has one 120 s clip giving **153 words on gcp-l4 and 253–275 on c3 CPU**. I have put to them that this is very unlikely to be "not bit-stable" and much more likely a repetition loop on the CPU backend, testable by counting unique n-grams before any WER bar is set. Precedent: 19 Sep, the Yoga was ruled out as a diarize producer because arm64/x86_64 diverge at speaker switches — cross-backend divergence disqualified the substitute rather than being tolerated with a threshold.

### What the three have in common

R1 is about **time**, N4/N5 about **untested guarantees**, and the twins about **output fidelity** — but all three only bite once `*_URLS` is set. The branch is well built for the state it ships in and unproven for the state it exists to reach. Merging dark is therefore not a compromise; it is the only step the evidence currently supports.

### T2 (join cap 15 min → 6 h) — accepted, and it corrects me

Justified by production: an operator batch put 67 room_window jobs against a single-flight join and 50 burned an attempt within the hour. I passed the 15-minute cap at `5301fd7` yesterday having checked it was enforced, never whether it was right.

## Verdict: PASS (merge dark). Enabling needs R1 closed, N4/N5 pinned, and twin parity established.
