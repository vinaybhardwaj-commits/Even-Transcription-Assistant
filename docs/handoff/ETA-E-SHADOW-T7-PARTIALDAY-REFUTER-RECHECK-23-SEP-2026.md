# ETA — E-shadow: T7 and the partial-day guard. REFUTER RE-CHECK. 23 Sep 2026

`vinay/e-shadow-runner` **@ `11c5d31`** (builder split-speaker), two commits on `a6ad1db`: `0995676` (T7 + one versioned reader) and `11c5d31` (the partial-day guard). Re-check of my T7 finding in `ETA-E-SHADOW-RUNNER-REFUTER-VERDICT-23-SEP-2026.md` and of the partial-day risk I raised when Fable re-ordered the run to "the moment it deploys". Own detached worktree `/tmp/refute-t7`, HEAD asserted as `11c5d31`; builder's worktree (`~/dev/eta-wt-shadow`) never touched. Mini kept out — every run on the Yoga.

**SCOPE FACT, stated first: neither commit is pushed and neither has a green gate.** `origin/vinay/e-shadow-runner` is still at `a6ad1db`; these objects are reachable only because the panes share one clone. Both gate attempts were blocked by a stuck Yoga lock **which was mine** (see the note at the foot). **This PASS is on the code, not on a gate.** It cannot deploy until pushed and gated, and the gate is the builder's to re-run.

## PASS — 6 of 6 killed, including every probe aimed at the part that is easy to get subtly wrong

| probe | result |
|---|---|
| **U1** — my T7: `triggers_tripped` is `some`, not `every` | **killed** |
| **U2** — `_firm` excludes provisional ones on a prefix (`partial` forced false) | **killed** |
| **U3** — a 3 h encounter is **never** provisional | **killed** |
| **U4** — `unjudged_over_90pct` **is** provisional on a prefix | **killed** |
| **U5** — `triggers_tripped` still reports the honest number, not silently firm | **killed** |
| **U6** — today is complete only once the last chunk is old enough (30 min → 300) | **killed** |

### T7 is closed, and pinned by a test that actually discriminates

The builder's own description is the right standard and it holds: the pinning test is a run with a three-hour encounter where the **other** triggers are untripped — precisely the shape under which `every` would call the run clean. A test where all five trip would have passed under either operator and proved nothing. U1 dies.

### The partial-day guard is better than the option I proposed

I suggested marking triggers provisional on a prefix. What was built is sharper: `provisional` is set on **exactly two** — `unjudged_over_90pct` and `no_encounters_on_a_day_with_transcripts` — while the other three carry `provisional: false` unconditionally.

That discrimination is the whole point, and I had not drawn it sharply enough. A prefix can **manufacture** a high unjudged share (recording runs ahead of transcription) or a zero-encounter count (two speech probes not yet accumulated). It cannot manufacture a three-hour encounter: if one exists in the first six hours, it exists, and the bridging rule has a hole no matter how much day remains. A blanket provisional flag — which is what my wording invited — would have suppressed the one trigger that most needs to stop a run mid-flight. **U3 pins that it is not suppressed.**

Two further choices worth crediting, both verified:

- **`triggers_tripped` keeps its old meaning and `triggers_tripped_firm` is a new field.** U5 mutates the old field to quietly exclude provisional triggers and dies. Redefining an existing field would have given every existing reader a different answer with no signal; adding one does not.
- **`day_complete` is stored on the run row**, so E-7 can tell a prefix run from a closed-day run when it compares them. That was the reason I gave for caring beyond the triggers, and it was taken.

### The append-only condition, met structurally

Fable accepted append-with-supersede on condition of a versioned reader. `readLatestRun` now keys on `(room_day_id, smoother_version)` and both readers pass one; dropping the version filter fails a test. Beyond that, the builder added a **structural** test that walks `lib/` and `app/` and fails if any file except `lib/encounter-hypotheses.ts` names the E-5 tables in SQL. That is stronger than what was asked: it enforces the single-writer invariant at the boundary rather than trusting each future caller, and it is the same shape as the drift guard on 0114 — check the property, not the instance.

## My own failure in this episode, recorded

The gate for both commits was blocked from 09:27 to ~10:45 by a hung Yoga CI lock. **The holder was my levels-re-check run**, not a runner fault and not the 887d1e9 run that had been suspected. It acquired `flock /tmp/eta-ci.lock` at 03:57:41Z, applied its patch, started vitest and stopped writing. scribe3 cleared it by hand and found the cause: a vitest-spawned **esbuild transform service** and one worker outliving their parent tree with no timeout of their own — nothing my local wrapper could reach.

Two things follow, and both are mine:

1. **My harness let the timeout escape.** `subprocess.TimeoutExpired` propagated out, so the run died with no summary and no row for the mutation it was on — a timeout was neither a verdict nor a recorded ERROR. Fixed: it now returns `ERROR "runner timeout after 2400s (no verdict)"` and continues, so a hung runner costs one row rather than a whole run. This is the third time today this class has appeared (`patch_missing`, the exit-code contract, lx's `NOAPPLY`) and I had raised the previous two, which is precisely why it should not have been open in my own tool.
2. **The cost was about 45 minutes of every pane's gate**, on the day a deploy-critical fix was queued. Reported to scribe3 as the owner and asked rather than touching their service; the session had been left dirty with my patch still applied, which they destroyed rather than leave for the next caller.

## Gate

- **Mine:** 6 mutations through the Yoga fast runner after the lock cleared, 0 runner errors, worktree verified clean at `11c5d31`.
- **The builder's:** 31 tests in the shadow file and four of their own mutations dead, quoted as theirs — **but no green gate on either commit**, both attempts having been blocked by my lock.

**Jev — not run.** A re-check of two narrow fixes to a module Jev scored at low confidence last round; a second call on effectively the same diff would add nothing, and I said last time that I would not cite that score as corroboration.

**Verdict: PASS on the code.** T7 is closed and pinned by the only test that discriminates; the partial-day guard makes the right distinction rather than the blanket one I suggested; the append-only condition is met structurally. **Not deployable as it stands** — unpushed and un-gated, for a reason that was my fault, not the builder's.
