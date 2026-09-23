# ETA — router_job_lost. REFUTER VERDICT. 23 Sep 2026

`vinay/router-job-lost` **@ `206acbf`** (builder scribe), one commit on production `d519d7b`. Worktree `/tmp/refute-rjl`, HEAD asserted, clean after every run. Gate per Fable's 20:0x ruling: **typecheck + the new test file + my mutations**, not the full suite.

- `npx tsc --noEmit` → **rc=0**
- `tests/unit/router-job-lost.test.ts` → **10/10**
- Mutations: **4 applied, 4 killed, 0 void**

## PASS-WITH-FIXES — the fix is right; the bound is calibrated against the wrong quantity

### What it closes, and it closes it properly

The root cause is stated rather than guessed: the router restarted ~13:17, its job file still said `running`, no thread would ever change it, the poll re-queued every 150 s for 4.5 h, and the overnight driver at concurrency 1 stalled behind it. A lost job is now a window failure like any other — window back to `closed` or parked at `DRAIN_MAX_ATTEMPTS`, job fails with its own code, **next drain submits a NEW router job from fresh progress, nothing resubmits in place**. That last clause matters: an in-place resubmit beside a job that might still be alive would pay for the window twice, and the comment says so.

| mutation | result |
|---|---|
| **M1** floor 30 min → 1 ms (everything lost at once) | **killed** |
| **M2 CONTROL** floor → 24 h (nothing ever lost) | **killed, 4** |
| **M3** the proportional term 2× → 0.5× audio | **killed, 2** |
| **M4** `max` → `min`, so the bound becomes the smaller term | **killed, 2** |

M2 is the control that matters: making the bound unreachable kills 4 tests, so the loss path is genuinely exercised and M1's death is not an artefact of a suite that never reaches it.

**There is no stale-write risk.** The router is polled, never pushes, and a declared-lost job's id is no longer polled — so a forgotten job that later completes is simply never collected. Safe by construction, not by guard.

### FINDING — the bound measures queue wait plus run time, against a router that runs one window at a time

The numbers are the author's own, and they make the risk computable.

- The router has a **single window semaphore** — one window at a time (`room-drain.ts:107`).
- A 900 s window's bound is `max(30 min, 2 × 900 s)` = **exactly 30 min**; the two terms coincide, so the proportional term buys nothing at the commonest size.
- Measured router time for a 900 s window is **12–640 s** (bake-off, 22 Sep). Worst case ≈ **10.7 min**.
- The clock starts at **submit** (`router_submitted_at`), so it counts **queue wait + run time**.

A job is therefore declared lost when `(N queued ahead + itself) × 10.7 min > 30 min`, i.e. **N ≥ 2** at worst-case speed. The comment's "room for a few windows queued ahead" is, at the measured worst case, **two**.

**Production runs `AUTO_DRAIN_BATCH_LIMIT=5`** (PLAN-v3.2 §0). `runAutoDrain` offers up to that many windows in a `for` loop, and `drainRoomWindow` on the async path **submits and returns** — polling is a later job step — so all five router jobs are submitted within seconds and queue on the one semaphore. At worst-case speed **the fifth is past its bound before it starts**.

**Why the consequence is not merely a wasted re-run.** A false loss costs local compute, not money (Whisper is local), and the window is re-drained — benign once. But `DRAIN_MAX_ATTEMPTS = 3` and the comment is explicit: *"three attempts, then park with a reason. Never retried again by this module."* Three false losses **park the window permanently**, which is unprocessed audio needing manual recovery. And the scenario concentrates exactly under a deep backlog on a slow run of windows — which is tonight's plan.

**The fix is cheap, and the signal already exists.** `lib/stt/adapters/route.ts:194` already distinguishes the router's own states:

```ts
state: st.state === "queued" ? "queued" : "running"
```

**A job the router reports as `queued` has not been forgotten — the router just answered about it by id.** That is the fix's own definition of lost ("a router job the router forgot"), and a queued job fails it. Bound the **running** time, or reset the clock when the state moves `queued → running`; `queued` is surfaced by the adapter and referenced nowhere in the bound. Failing that, tie the floor to the batch limit rather than to a single window's run time.

### Smaller notes, no action

- `router_first_polled_at` for jobs submitted before this change is the right migration-free choice — it bounds the old population from first poll rather than pretending a submit time it never recorded.
- "any 404 for the id" is broad, but the direction is safe: a false loss re-drains. It is the *repetition* that is costly, which is the finding above, not this.

## Verdict: PASS-WITH-FIXES
The diagnosis is exact, the failure is recorded rather than swallowed, nothing resubmits in place, and the bound is pinned in both directions by a real control. The finding is that the 30-minute floor was calibrated against how long one window takes, while what it actually measures is how long five of them take to get through a one-at-a-time router — and the knob that sets that depth lives in a different file. Worth closing before the overnight backlog drain, because that is the run that produces the queue depth.
