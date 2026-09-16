# ETA — CI has been decorative since 25 August · finding + queued round
**14 September 2026 · Orchestrator · read from `.github/workflows/` on the Mini while FIX4 and M6 were in flight**

The Builder surfaced this while answering C18. I read both workflows myself. C18 stays report-only and
**FIX4's contract does not change** — extending a contract mid-flight is the FIX1 mistake. This is queued
as its own round.

## 1. What the two workflows actually do

**`ci.yml`** — triggers on `push` to `main` and `pull_request` to `main` **only**.
Steps: checkout · node 22 · `npm install` · `npm run typecheck` · install vitest ephemerally ·
`npx vitest run` · **`npm run check:silent`**.

**`e2e.yml`** — `workflow_dispatch` plus `schedule: 0 2 * * *` — daily **02:00 UTC (~07:30 IST), before
clinic** — running Playwright against `E2E_BASE_URL`, defaulting to **production**.

## 2. Three consequences, all material to the S1 merge

**2.1 Pushing `vinay/s1-auto-drain` triggers no CI at all.** CI is gated on `main`. Until S1 opens a pull
request, the Refuter's rerun of the gate on the Mini is the **only** proof that exists. There is no second
opinion coming, so the Refuter's verdict carries the full weight. That is a reason to keep briefing it
hard, not a reason to add CI now.

**2.2 CI cannot go green, and that is by construction, not a regression.** Its final step is
`npm run check:silent`, which exits **1** with the **9 accepted** silent-failure handlers — the nine
ratified at `1193083`, all in `app/[slug]/…`. The gate and the accepted-findings policy contradict each
other, so every run is red. Eight consecutive failures since 25 August is the symptom, not the disease.
**When S1 finally goes to `main`, CI will be red for a reason that has nothing to do with S1** — at exactly
the moment we would most want the signal.

**2.3 The id guard and the whole vitest suite DO run in CI** (`npx vitest run` collects every test file),
which is the second net the FIX3b Refuter said was missing on H1. It exists. It is just permanently red, so
nobody reads it. **That is worse than absent.**

## 3. This is the third time this shape has appeared

- 13 Sep: two health probes permanently red, **both the probe's fault**.
- 14 Sep: `check:silent` exits 1 on every single run, in CI, by design.
- And the lesson already written down for the first one: *a signal that is always red teaches everyone to
  ignore it.*

A red light nobody can ever turn green is not a safety net; it is a habit of looking away, and it costs
most on the day something real breaks.

## 4. Queued round — S2-CI, after FIX4 is verdicted

**Ruled in principle, to be briefed properly when FIX4 closes.** `check:silent` gets a **baseline
allowlist** of the nine accepted handlers — file and reason per entry, dated — so the gate exits **0** on a
clean tree and fails on any **new** silent-failure handler. This is the same shape as
`SYNTHETIC_CLINICIAN_IDS` in the id guard, a pattern this repo already uses and which FIX3b's R7 just
re-proved (20 entries, 0 not matching the shape). It preserves the policy and restores the signal.

Rejected alternatives: dropping `check:silent` from CI (loses the net); fixing all nine (they are accepted,
and that is a separate decision).

**Two things to establish in that round, not assumed here:**
1. Whether the real-Postgres suites actually run on `ubuntu-latest` or silently skip for want of a
   container. Testing rule 8 applies: a proof that can silently skip is not a proof. If they skip, CI's
   `vitest run` is much weaker than the Mini gate and should say so out loud.
2. Whether the allowlist should key on file path, on a hash of the handler, or on an explicit annotation in
   the source. A path-keyed entry goes stale silently when the file moves.

## 5. Unchanged by any of this

The S1 merge sequence stands: Refuter verdict → push branch → Vercel preview → watch the **seventh** cron
(G11) → manual promotion → migrations 0091 and 0092 under `SET lock_timeout = '3s'`, out of clinic hours →
`ROOM_AUTO_DRAIN_ENABLED` on **one room only**. Note for that last step: the nightly E2E tests the
doctor-facing app, **not** the drain, so it will not catch an auto-drain fault. The drain's own signal is
the coverage report.
