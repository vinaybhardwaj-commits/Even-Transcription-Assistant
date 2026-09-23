# ETA — emotion backlog throughput. REFUTER VERDICT. 23 Sep 2026

`vinay/emotion-backlog-throughput` **@ `c979609`** (builder yoga-drain), one commit on production `2640cca`. Lane L1→L9. Worktree `/tmp/refute-emo`. `tsc --noEmit` **rc=0**. Suite run **on the box** (see below): `c2-e2e-runner` **55/55**, including the new test, 147 s against real postgres.

## PASS-WITH-FIXES — the change is right and inert by default; its only test cannot fail

### The root cause is honest, and the scope is smaller than the title

Verified structurally, not taken: the enqueue scan carries `AND w.clip_r2_key IS NOT NULL`. So the **1,146 of 1,183 windows (97%) with no clip are invisible to it**, and no value of the new limit reaches them. This change addresses **23 windows**. The builder says exactly that — *"not fixable by throughput, needs a re-join, separate task"* — and I am repeating it because "emotion backlog fix, PASS" reads like the backlog is solved. **The re-join that would fix the other 97% is not assigned to anyone in LANES.**

The design is otherwise sound: `EMOTION_BATCH_LIMIT`, default 1, clamped 1..10 through the same `clampedIntEnv` as `AUTO_DRAIN_BATCH_LIMIT`, the busy gate untouched, behaviour byte-identical with the env unset. I also checked the interaction that bit `router_job_lost` tonight — batching more work against a single-lane consumer — and it does **not** apply: emotion jobs are bounded by `EMOTION_MAX_ATTEMPTS`, not by elapsed time, so a deeper queue cannot cause false timeouts.

### FINDING — the one test of this change derives its expectation from the thing under test

**E1 survives**: changing the default from `1` to `5` leaves **55/55 green** on the box, patch confirmed applied and reverted by the runner.

`tests/unit/c2-e2e-runner.test.ts:1517` imports the constant and then measures against it:

```ts
const { EMOTION_BATCH_LIMIT } = await import("@/lib/emotion/enqueue");
const ids = Array.from({ length: EMOTION_BATCH_LIMIT + 2 }, …);
expect(e.enqueued).toHaveLength(EMOTION_BATCH_LIMIT);
expect(e.enqueued.map(x => x.window_id)).toEqual(ids.slice(0, EMOTION_BATCH_LIMIT));
expect(q[0].n).toBe(EMOTION_BATCH_LIMIT);
```

Seed `LIMIT + 2`, expect `LIMIT`. Whatever the constant is, the test agrees with it: 1 → seed 3, expect 1; 5 → seed 7, expect 5. The default is unpinned in either direction.

**The test's own claim is conditionally true and never exercised.** Its comment says it *"proves the SQL actually uses the live constant"*. It would — **if the constant were ever something other than 1 while the test runs.** Nothing sets `EMOTION_BATCH_LIMIT` before the import that freezes it, so the constant is always the default, and a hardcoded `LIMIT 1` is indistinguishable from `LIMIT ${EMOTION_BATCH_LIMIT}`.

**A mutation of mine that does NOT support this, disclosed:** I also ran `LIMIT ${EMOTION_BATCH_LIMIT}` → `LIMIT 1` (E3). It survived, but it is an **equivalent mutant** under the test's environment — with the env unset the constant *is* 1, so the two are behaviourally identical. E3 is not evidence and I am not counting it. Only E1 stands.

**Fix, and it is small:** set the env var to a value ≠ 1 before the dynamic import that reads it — the test already uses `await import(...)`, so `vi.resetModules()` plus `process.env.EMOTION_BATCH_LIMIT = "3"` before it is enough. Then seeding 5 and expecting 3 genuinely distinguishes a live constant from a hardcoded 1, and E1 dies.

### The header's operational claim is wrong, for the same root cause

`EMOTION_BATCH_LIMIT` is a **module-level `const`**, so its value is frozen at import. The header says the lever lets a quiet night pre-load more work *"without a code change or redeploy"*. Setting the variable alone will **not** take effect — the module must be re-imported, which in production means a redeploy.

If that sentence is read literally during tonight's backlog push, the variable gets set, nothing changes, and the natural conclusion is that the fix does not work. One clause in the comment fixes it. It is the same frozen-at-import fact that makes the test vacuous — one cause, two consequences.

### On where this was verified

`dockerAvailable()` is **false on the Mini** after the Docker-to-E2E migration: `docker version --format {{.Server.Version}}` returns a 500 against the stale desktop-linux socket, while `docker ps` and `docker run --gpus all` work through the `e2e` context. So this suite reports *"Docker is not available here"* locally — **1 failed, 54 skipped** — and my first mutation baseline was red. I discarded it and re-ran everything on the box, where all 55 tests execute. Handed to `eta-refuter-2` (infra lane). Recorded here because it is why this verdict's evidence is box-run rather than local.

## Verdict: PASS-WITH-FIXES
The change is correct, conservative, inert with the env unset, and honest about its own scope. It should not ship believing it is tested: its only test agrees with the constant whatever the constant is, and the lever it adds will not move until a redeploy. Both are one edit each, and neither is a reason to hold the change.
