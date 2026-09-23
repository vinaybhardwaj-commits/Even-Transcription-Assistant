# ETA — room_window reaper. REFUTER VERDICT. 23 Sep 2026

`vinay/room-window-reaper` **@ `6a751d0`** (builder scribe), one commit on production `2640cca`. Lane L9. Worktree `/tmp/refute-reap`. `tsc --noEmit` **rc=0**; `room-window-reaper.test.ts` **23/23** (no Docker needed — the DB wrapper takes an injectable `sql`). **7 mutations, 6 killed, 1 equivalent (disclosed, not counted).**

## PASS

### The root cause is real and the diagnosis is specific

56 production windows stuck at `bench_window.state='transcribing'` because `cancelJob()` is a generic job-system primitive that never runs room-drain's `recordFailure` — the only code that moves a window off `transcribing`. The window is then invisible: not `closed` (auto-drain only offers `state='closed'`), not `failed` (nothing flags it). Correctly generalised: **any** cancelled or bookkeeping-bypassed job strands its window this way, not only the serial-retry cancellations that surfaced it.

| mutation | result |
|---|---|
| **R1** staleness 15 min → 0 | **killed, 2** |
| **R2** `DRAIN_MAX_ATTEMPTS` 3 → 99 (never parks) | **killed** |
| **R3** cap 200 → 1 (sweep truncated) | **killed, 2** |
| **R4** status filter dropped, so `'done'` is reaped | **killed, 2** |
| **R5** staleness check dropped, so live jobs are reaped | **killed, 2** |
| **R6** `exhausted` inverted (parks when it should reopen) | **killed, 7** |

R4 and R5 matter most: they are the two things a reaper must never do, and both are pinned.

**The best decision in the branch is the one that does nothing.** A window whose latest job is `'done'` but which is still `'transcribing'` is **left alone and flagged as an anomaly**, because `done` should mean `roomWindowFinish` already moved it. A reaper is a tool that erases evidence by design; choosing to report the state it cannot explain rather than repair it is the right instinct, and R4 shows it is enforced rather than merely intended.

**Not incrementing `attempts` is correct.** A job cancelled for serial-retry never spent a real transcription attempt, so charging it one would park healthy windows after three unlucky cancellations. The existing counter is still respected — `attempts >= 3` parks to `failed` — so the bound is honoured without being consumed.

### EQUIVALENT MUTANT, disclosed and not counted

**R7 survives**: dropping `if (finishedMs == null) return false;` leaves 23/23 green. It is not a gap. `lib/jobs/store.ts:195` cancels with `finished_at = now()`, and the failure paths at `:157`/`:180` do the same, so every row that passes the status filter has a timestamp and the guard is unreachable.

It is worth keeping all the same, and worth a sentence on *why*: if a future path ever cancelled without stamping `finished_at`, `null <= staleBeforeMs` coerces to `0 <= …` → **true**, and the row would be reaped as *infinitely stale*. The guard's whole value is refusing to let a missing timestamp mean "oldest possible". Same shape as the `|| !j.kind` guard on E-6 — defensive code made unreachable by its only producer.

### OBSERVATION — the cancel→reap→cancel cycle has no odometer

Because the reaper never increments `attempts` (rightly), a window that is *systematically* cancelled can cycle indefinitely: `closed` → offered → job → cancelled → reaped → `closed`, once per hourly sweep, with no counter rising anywhere.

In practice this self-limits, because the cause — one-drainer-at-a-time contention — is transient, and each cycle is cheap: no transcription work is done. So this is not a blocker and I would not change the attempts decision.

But there is currently **no way to see a window doing it**. The branch already has the right instinct one line up, in the `done`-anomaly flag; the same treatment here — a reap count or a per-window reason in the sweep's output — would make a looping window visible instead of merely harmless. Worth doing before the next time a window is stuck and nobody can tell whether it has been reaped once or forty times.

## Verdict: PASS
A precise diagnosis, a fix that mirrors the code it is compensating for, the two dangerous behaviours pinned by tests, and the judgement to flag rather than repair what it cannot explain. The one survivor is equivalent and I say so.
