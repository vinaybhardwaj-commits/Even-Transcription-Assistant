# ETA — scribe_room_levels, the three fixes. REFUTER RE-CHECK. 23 Sep 2026

`vinay/levels-mcp-read` **@ `89ccd57`** (builder split-speaker). Re-check of the finding and two notes in `ETA-ROOM-LEVELS-RANGE-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktree `/tmp/refute-lv2`, HEAD asserted; nothing pushed.

**Runner note, stated up front:** this set ran **locally on the Mini**, not on the Yoga, and why is in the infra section at the foot — it matters to how the numbers should be read.

## PASS — my finding is closed and the fix is not over-tight. 5 of 6 killed; the survivor is a narrow real gap

| probe | result |
|---|---|
| **V1** — my L1: a naive ISO stamp is refused, not read in the server's zone | **killed** |
| **V2** — an explicit offset is still accepted (fix not over-tightened) | **killed** |
| **V3** — the omitted-`to` default is the next IST midnight | **killed** |
| **V4** — *control*: the 24 h cap | **killed** |
| **V5** — *control*: `to` still exclusive in the filter | **killed** |
| **V6** — a bare date refused as a bound | **survived** |

### L1 is closed, and closed the way the module's own rule demanded

`parseIstBound` now refuses an ISO stamp without `Z` or an explicit offset — *"naive stamp: whose clock? refuse"*. Removing that guard is caught (V1). The fix follows the principle the header states twice rather than resolving the ambiguity in whatever zone the server happens to run in.

**And it is not over-tight, which is the half worth checking.** V2 narrows `ISO_WITH_OFFSET_RE` to `Z` only and dies, so `+05:30`, `+0530` and `-08:00` are genuinely still accepted. A fix that refused every ISO stamp would also have killed V1 and would have been wrong.

`to` now means exclusive in both the parameter and the omitted default — the default is the next IST midnight rather than `23:59:59.999` (V3) — and `istDaysSpanned` no longer reads a wasted day for a range ending exactly at midnight. Both notes closed.

### V6 — the one gap, and it is the same family as the finding

Removing `if (!/[T ]/.test(v)) return null;` survives. Nearly equivalent: a bare date has no offset, so the new `ISO_WITH_OFFSET_RE` guard refuses it anyway. I measured the difference rather than assuming it, and there is **exactly one** input class where the two disagree:

```
input               has T/space   offset RE   Date.parse          mutant accepts?
2026-09-22          false         false       1790035200000       no
2026-09-22+05:30    false         true        NaN                 no
2026-09-22Z         false         true        1790035200000       YES  <- differs
20260922            false         false       NaN                 no
```

So the `[T ]` check still does real work for exactly one shape: **a date-only string carrying `Z` or an offset**. Without it, `2026-09-22Z` is accepted and parsed as **midnight UTC — 05:30 IST**.

That is the L1 bug wearing a different hat: a caller who writes a day where a bound belongs gets a bound 5.5 hours from the IST midnight they meant, silently. The guard's own comment — *"a bare date is a day, not a bound"* — names precisely the confusion it is still uniquely preventing, and nothing tests it. One assertion: `parseIstBound("2026-09-22Z", day)` is `null`.

## Infra — three Yoga wedges on this target, and the numbers above are from the Mini

This set could not be run on the Yoga. It wedged the CI lock **three times out of three on this exact target**, while other panes' runs on other targets completed normally throughout.

- Runs 1 and 2 (09:27, 11:16) each held `flock /tmp/eta-ci.lock` until scribe3 cleared it by hand — **the first cost roughly 45 minutes of every pane's gate, and it was mine.**
- Run 3 (11:45) hung identically but my own fix contained it: **ABORT at 180 s**, one row, no cascade, lock free, other panes unaffected.

scribe3's root cause: under multi-pane load the Yoga kills esbuild's transform service and **vitest has no timeout on its wait**, so vitest holds the lock forever. They disproved my session-poison hypothesis directly — a genuinely fresh session hung the same way — and shipped `--fresh-session` regardless.

**The decisive datum is local:** this exact file, unmutated, runs in **514 ms, 29/29 passing**. So the test is not the problem; the runner is, for this target. The six mutations then took seconds locally.

I wrote `local_mutate.py` for it, with the same integrity contract as the Yoga harness — restore in a `finally`, every outcome classified, and **the worktree asserted clean at the end** (it reported `YES`). It is deliberately scoped to **one targeted vitest file**: full suites, typecheck and builds still belong on the Yoga, and this is not a route around that.

**Two corrections to my own tooling came out of this, both mine:**

1. A runner timeout used to **crash** the harness (`TimeoutExpired` escaped), so a hang produced no summary and no row. Fixed to record it.
2. Then recording it and **continuing** was worse — the next mutation queued behind the same wedged runner, turning one hang into a loop. Now `ABORT` on the first such timeout.
3. And the real defect was duller than either: **a 2400-second timeout on a run that takes 20–30 seconds.** At 180 s both earlier incidents would have been three minutes and one row instead of forty minutes and a blocked programme. I spent longer reasoning about *why* it hung than about *how long I waited before giving up*, and only the second was costing anyone anything.

**Verdict: PASS.** The finding is closed at the level it was raised, the fix is not over-tight, and both smaller notes are closed. One assertion outstanding on `2026-09-22Z` — a bare date with a timezone marker, which is the only shape the `[T ]` guard still uniquely refuses, and which would otherwise land 5.5 hours from the IST midnight the caller meant.
