# ETA — J-CORE: the flag convention's falsy half. REFUTER RE-CHECK. 23 Sep 2026

`vinay/jev-core` **@ `b1618b0`** (builder fleet), on `e391d24`, **now on origin**. Re-check of the finding in `ETA-JEV-CORE-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktree `/tmp/refute-jc2`, HEAD asserted. Nothing pushed, no Jev call made.

**Scope: 22 lines added to `tests/unit/jev-client.test.ts`, tests only** — correct, because the finding was a coverage gap and not a defect: the source already called `parseFlag`.

## PASS — 4 of 4 killed. The convention is now pinned on both halves

| probe | result |
|---|---|
| **K1** — my J2b: `Boolean(process.env[name])` must not pass | **killed** |
| **K2** — the `=== "on"` hand-roll still caught (truthy half) | **killed** |
| **K3** — a malformed value **throws** rather than being swallowed to `false` | **killed** |
| **K4** — *control*: the gate still fires before any fetch | **killed** |

### The two tests are aimed at the property, not at the mutation

`ETA_JEV_ENABLED=off` now asserts `JevDisabledError` **and** that `fetchImpl` was never called; `=maybe` asserts `FlagValueError` **and** no fetch. Asserting the absence of the network call alongside the thrown type is what makes these more than type checks — a flag that threw the right error *after* calling out would still be wrong, and the `fetchImpl` spy is the only thing that could tell.

**K3 is the one I would keep.** It mutates the call site to `try { parseFlag(name) } catch { return false }` — the *shape a future tidy-up actually takes*, since swallowing an exception to "be safe" reads as defensive rather than dangerous. That it dies means the throw is pinned as a behaviour, not merely inherited from the helper.

### Why this mattered more than one branch

§2 of PLAN-v3 routes five future flags through this one helper — `JEV_NOTE_FAITHFULNESS`, `JEV_ENCOUNTER_CONTENT`, `JEV_SPEAKER_ROLE`, `JEV_COLLAPSE_VETO`, `JEV_CLINICAL_ROUTE` — all specified default-OFF and turned on one at a time behind evidence. The gap was one helper, five uses, and the failure direction was *enabling by accident*: under `Boolean(env)`, `off` and `false` would both have switched Jev on.

This was the **third** time today the same gap appeared — retention (R2), then jev-core (J2b) — and the first two were in a route and a client that had nothing else in common. Fixed here it stops being a pattern, because the next four uses inherit a helper whose falsy half is now tested.

The comment fleet left records the reasoning rather than the instruction, which is the part that survives into next month.

## Gate

- **Mine:** 4 mutations locally, 0 errors, worktree asserted clean at `b1618b0`.
- **The builder's:** as recorded on the branch.

**Jev — not run**, for the same structural reason as the first verdict: this diff is the Jev layer, so scoring it would ask the tool to judge its own client.

**Verdict: PASS.** Both halves of the convention are pinned, the tests assert the absence of the network call as well as the error type, and the finding that appeared three times today is closed at the point where five future uses inherit it.
