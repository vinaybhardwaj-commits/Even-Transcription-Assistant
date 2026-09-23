# ETA — level-log retention, the parseFlag fix. REFUTER RE-CHECK. 23 Sep 2026

`vinay/level-log-retention-enable` **@ `887d1e9`** (builder fleet), one commit on `c50ff72`: the retention route and its test. Re-check of R2 in `ETA-LEVEL-RETENTION-ENABLE-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktree `/tmp/refute-ret2`, HEAD asserted. Nothing pushed, **no route invoked, no row deleted**.

**Runner: local.** The Yoga wedged on this target too; detail at the foot. The local baseline is 39 tests in 479 ms.

## PASS — 7 of 7 killed. R2 is closed, and the half that is easy to lose is pinned too

| probe | result |
|---|---|
| **W1** — my R2: the flag uses `parseFlag`, not a truthiness check | **killed** |
| **W2** — reverting to the exact old hand-roll `=== "on"` | **killed** |
| **W3** — an unrecognised value **throws** rather than being swallowed as off | **killed** |
| **W4** — *control*: nothing deletes without the flag | **killed** |
| **W5** — *control*: an explicit `dryRun` is honoured even when enabled | **killed** |
| **W6** — *control*: the cron GET is authenticated | **killed** |
| **W7** — *control*: the 7-day window | **killed** |

### R2 is closed at the level it was raised

`const enabled = parseFlag(RETENTION_ENV)` replaces the hand-rolled `=== "on"`, and the comment records why in the operator's terms rather than the programmer's: an operator who wrote `BENCH_LEVEL_RETENTION=true` — the value that works everywhere else in this codebase — *"got a silent forced dry run while believing deletion was capping the table."* That is the failure I described, written down where the next person will meet it.

**W2 is the sharper of the two probes.** W1 proves the flag is not a bare truthiness check; W2 proves the specific historical bug cannot return, because a test now pins that `true`/`1`/`yes` **do** enable it. A fix that merely stopped `off` from enabling deletion would have satisfied W1 and left the operator-facing half untouched.

### W3 — the property that could most easily have been lost, and was not

Swapping `parseFlag` for a hand-rolled check removes a behaviour the old code never had: `parseFlag` **throws** on an unrecognised value instead of reading it as off. W3 wraps the call in a `try/catch` that swallows to `false` — restoring the old silent-disable — and **dies**. So the throw is genuinely pinned, not merely inherited.

I traced where that throw lands before treating it as an improvement. Both handlers wrap `runRetention` in `try/catch` → `console.warn` → `PIPELINE_FAILED` (`route.ts:144-149`, `156-161`). For the hourly cron this means a typo'd flag **fails loudly every hour** rather than silently disabling retention while the table grows unbounded — which is the direction R2 wanted, and strictly better observability than what it replaced. The throw happens before any query, so a bad flag costs nothing at the database.

### Still open from the first review, unchanged by this commit

`adminOrSecret` is still copied into both route files rather than shared. Identical today; an auth change to one would not reach the other, and one of the two is the delete path. Not this commit's business — recorded so it is not lost.

## Infra — CORRECTED: my run was QUEUED, not wedged, and my 180 s abort was the defect

**I got this wrong and scribe3 corrected it.** I launched this set on the Yoga with `--fresh-session` and the 180 s abort, it returned no RESULT, and I wrote that the Yoga had wedged on this target too — and drew a conclusion from it. scribe3 checked directly: `887d1e9` was **not stuck**. It was genuinely queued, second in line behind a real run whose log they watched growing with live test output. It would have got its turn.

**So my 180 s abort fired on a queue wait, not a hang** — and that is a defect in my own fix, not in the Yoga.

The error is the same shape as the three I made earlier today: I read a symptom and asserted a cause without checking. *"180 s elapsed, no RESULT"* is produced identically by a wedged runner and by an ordinary queue, and I had no way to tell them apart because I was measuring **total elapsed time** rather than **progress**. 2400 s was too long to be useful; 180 s is too short to survive a normal queue. Both numbers answer the wrong question.

**The right discriminator is the one I handed scribe3 for their `--unstick` helper an hour earlier and failed to apply to myself:** a run is wedged when its log *has stopped growing*, not when the clock has run on. A queued run has no log growth either — but it also has no lock, which is why the server is the right place to make this judgement and the client is not.

**Fixed accordingly.** scribe3 has since shipped a hard wall-clock watchdog on the runner (600 s from lock acquisition, kills by CWD match so it catches esbuild's service — which is what a command-line-only `pkill` missed twice today — releases the lock and writes `RESULT runner_error:timeout`). With the server self-healing and reporting a reason my harness already classifies as ERROR, the client timeout should sit **above** the server's watchdog plus a reasonable queue allowance, not below it. Raised to 1200 s: long enough that a queue wait is never mistaken for a hang, short enough to be a genuine backstop if the server-side watchdog itself fails.

**What still stands from this episode:** the Yoga genuinely did wedge twice earlier today, both on `mcp-room-levels.test.ts`, both needing a manual clear, and the first cost roughly 45 minutes of every pane's gate. Those were real. This third case was not one of them, and my claim that a different target proved the cause was **built on a misreading** — the conclusion happens to agree with scribe3's independent diagnosis, but my evidence for it was wrong and I withdraw it.

**The mutation numbers above are unaffected:** they were produced locally, 7 of 7, worktree asserted clean.

**Jev — not run.** A one-line flag change plus tests, on a route whose safety I verified by execution against each guard. A scalar score adds nothing to "does the flag still gate the DELETE", which the table above answers directly.

**Verdict: PASS.** R2 is closed, the operator-facing half is pinned by W2, the throw-rather-than-disable property is pinned by W3, and all four safety controls from the first review still hold.
