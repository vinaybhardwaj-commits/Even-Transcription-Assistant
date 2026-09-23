# ETA — emotion backlog throughput, fixes. REFUTER RE-CHECK. 24 Sep 2026

`vinay/emotion-backlog-throughput` **@ `7a1ef8e`** (builder yoga-drain), one commit on `c979609`. Worktree `/tmp/refute-emo2`. Mutations run **on the box** (the suite needs real postgres; `dockerAvailable()` is false on the Mini).

## PASS — my finding is closed; one smaller, adjacent gap remains

### FIX 1 — the test now discriminates

| mutation | at `c979609` | at `7a1ef8e` |
|---|---|---|
| **E3** the SQL hardcodes `LIMIT 1`, ignoring the constant | equivalent (constant *was* 1) | **KILLED, 2 tests** |
| **E1** the default moves `1` → `5` | **survived** (the finding) | survives — see below |

The test sets `EMOTION_BATCH_LIMIT=3` **before** `vi.resetModules()` and a fresh import, seeds a **fixed** 5, and expects a **fixed** 3. No expectation is derived from the constant any more, so a hardcoded `LIMIT 1` now fails where it previously could not.

**The best line in the fix is the one guarding its own setup:**

```ts
expect(EMOTION_BATCH_LIMIT, "the env override must actually be read on this fresh import").toBe(3);
```

The whole repair depends on the fresh import genuinely picking up the env var. Without that assertion, a `resetModules` that silently failed would leave the constant at 1, the test would seed 5 and expect 3, and fail *confusingly* — a puzzle rather than a diagnosis. Asserting the precondition turns a subtle setup dependency into a loud, self-diagnosing one. It is a positive control: prove the instrument works before trusting its reading.

### FIX 2 — the operational claim is now correct

The header no longer says the lever works "without a code change or redeploy". It says:

> *"NOT LIVE-TUNABLE. … read from `process.env` ONCE when this module is first loaded — so setting or changing the env var takes effect on the NEXT DEPLOY (a fresh module load), never on an already-running instance. Do not expect a dashboard env-var edit alone to change tonight's pacing; it has to ride a deploy."*

That is the fact, stated where an operator will hit it, and it names the failure mode rather than just the mechanism.

### FINDING (smaller, and adjacent rather than the same one) — the DEFAULT is unpinned

**E1 still survives**, and now for a different reason: the test pins the **env-override** path at a fixed 3, so the default is irrelevant to it. Nothing anywhere asserts that the default is 1.

That matters because **the default is the production value** — `EMOTION_BATCH_LIMIT` is unset in production, so the shipped behaviour is whatever the literal in `clampedIntEnv(…, 1, 1, 10)` says. A change from `1` to `5` would quintuple the enqueue rate against the Mini's one emotion model on RAM shared with whisper, the router, diarize and the recorder — exactly the pacing the file header sets out to protect — and no test would notice.

I am not claiming this is the finding I raised; it is the one the fix reveals, and it is smaller. One line closes it: assert the default with the env **unset** (a second `resetModules` import with `delete process.env.EMOTION_BATCH_LIMIT`, expecting 1), which also documents that unset means conservative.

## Verdict: PASS
Both fixes do what was asked and the test is now capable of failing for the reason it exists. The remaining gap is the default's own value, which the fix did not touch and did not claim to.
