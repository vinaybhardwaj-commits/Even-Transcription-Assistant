# ETA — overnight driver round 2 (F1–F4). REFUTER VERDICT. 22 Sep 2026

`vinay/overnight-translate` **@ `faa484b`** (builder scribe3), on top of `60b3072`. Diff: `driver.ts`, `select.ts` and their two test files. Reviewed in my own detached worktrees (`/tmp/refute-ot3`, `/tmp/refute-ot3-mut`, `/tmp/refute-ot4-overlay`). The driver was not started. Production DB: read-only via `ro_query.py`, counts only.

## PASS

Every finding from `ETA-OVERNIGHT-DRIVER-FIX-REFUTER-22-SEP-2026.md` is fixed. Three low test gaps remain; none blocks.

### F1 — both probes now end fatal
My own probes (real driver loop, local fakes, 200 windows):

| Probe | concurrency 1 | concurrency 3 |
|---|---|---|
| A: every job cancelled by someone else | 5 submits, `fatal=foreign_cancels` | 6 submits, `fatal=foreign_cancels` |
| B: join service held all night | 15 submits (5 windows × 3 tries), `fatal=join_contention` | 18 submits, `fatal=join_contention` |
| C: foreign cancel and join contention alternating | fatal after 9 windows | — |
| D: 4 foreign cancels, then 1 real failure | no fatal (the canary counter is untouched) | — |
| E: 4 failures, 1 foreign cancel, 1 failure | `too_many_failures` (a foreign cancel does not reset the canary) | — |

The supervisor (`~/overnight-translate/ot-supervise.sh`) exits with the driver's code and the plist has no KeepAlive, so a fatal stop **stays stopped**.

### F2 — own failures only, contention excluded; the 143 claim is verified
All 4 queries now count `args->>'actor' = 'overnight-translate'` and skip errors containing `join_already_running`. Checked against production: the driver's jobs do carry `args.actor = 'overnight-translate'`, and all 487 contention failures carry that substring in `error`. Recount (read-only, now):

| | windows |
|---|---|
| parked under the old rule (≥2 failed, any actor) | **144** (was 143; one more since my last count) |
| eligible again under the new rule | **143** |
| still parked under the new rule | **1** |

83 of the 143 have a `room_diarize_window` row. I did not check how many of the other 60 the selector's other conditions still exclude, so 143 is an upper bound on what the driver will actually pick. `DEFAULT_MAX_FAILED_JOBS = 2` is pinned (M11 killed).

### F3, F4
The guard is renamed `RECENT_WINDOW_ACTIVITY_MINUTES` and documented as a per-window duplicate-work guard, not a fix for the join mutex. The 5→0 mutation is now killed (M10). The foreign-cancel comment is correct now.

### Staged bundle
I built my own overlay: `248c2ae` with `lib/overnight-translate/` and `scripts/overnight-translate.ts` taken from `faa484b`. After normalising the `node_modules` path in comments, it is **identical** to `~/dev/_fable/scratch/overnight-translate.staged.mjs` (raw sha256 `a7edb58939eacf9e…`, as Fable quoted).

## Mutations — 11 of 14 killed
Killed: M1/M2 (a streak never advances), M3 (done does not reset the foreign streak), M6 (join limit 5→50), M7 (foreign cancel feeds the canary), M8 (actor scope dropped, 8 sites), M9 (contention exclusion dropped, 4 sites), M10, M11, M12 (NULL error no longer counted), M14 (old clause in one query).

Survived — low, test gaps only:
- **M4**: done does not reset the **join** streak. The "done resets BOTH" test only uses foreign cancels.
- **M5**: foreign limit 5→50. Probe A's test reads the constant, so it moves with it. M6 dies only because an older test hardcodes 6 windows.
- **M13**: a join failure resets the foreign streak. The independence test stays below both limits. Harmless in practice: the join streak still fires (probe C).

Also low: the old test "foreign cancels do not touch consecutiveFailures" is now an **empty body**. The behaviour is still pinned by the existing "foreign cancel between two real failures" test and by M7 being killed.

## Gate
Targeted vitest (driver, select, retry): green on `faa484b`. I did not rerun the full suite: other panes were running theirs on the Mini. scribe3 reports 3603 passed.

## Jev — diff only, none of my findings in its context
Scores 7.5–8.4, all "strong". Its lower ones:
- **compatibility 7.5**, "breaks a contract" — **rejected**. The renamed option `recentActivityMinutes` has no caller outside the two files, and nothing outside the driver reads the fatal codes.
- **observability 7.6** — **rejected**. Both stops log `fatal` with `consecutive`, and exit 2 reaches the wrapper log.
- **testQuality 7.8**, "tests run code without proving the outcome" — **confirmed**: the empty test body, plus M4/M5/M13.
