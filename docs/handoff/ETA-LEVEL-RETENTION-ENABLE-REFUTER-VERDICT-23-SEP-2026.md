# ETA — level-log retention, the enable path. REFUTER VERDICT. 23 Sep 2026

`vinay/level-log-retention-enable` **@ `c50ff72`** (builder fleet): the hourly flag-gated cron entry in `vercel.json`, the retention route's cron/GET path, a new dry-run report route, `oldLevelSamplesByRoom`, and tests. Own detached worktree `/tmp/refute-ret`, HEAD asserted as `c50ff72` before the run. Nothing pushed, **no route invoked, no row deleted, no database written**. Mini kept out — every run on the Yoga fast runner.

## PASS-WITH-FIXES — the delete path is properly gated; the flag that gates it is hand-rolled

This is the one change today that can destroy production data, so the structural guards come first. They hold.

### The safety architecture is right — 10 of 11 mutations killed

- **Nothing deletes without the flag. R1 dies.** `dryRun = dryRunRequested || !enabled`, so a DELETE needs `enabled && !dryRunRequested`. The schedule alone deletes nothing.
- **An explicit `dryRun: true` is honoured even when enabled. R3 dies.**
- **The cron GET is authenticated. R4 dies** — `x-vercel-cron` (which Vercel strips from inbound requests) or `Bearer CRON_SECRET`, the same pattern as `/api/admin/reap-stuck`.
- **POST requires an admin cookie or `MIGRATION_SECRET`. R5 dies.**
- **The window and the cutoff are pinned. R6** (7 days → 0) **and R7** (the cutoff shifted a day later) **both die.** The arithmetic is conservative in the safe direction: `ist_date < cutoff` with a 7-day subtraction keeps **eight** calendar days including today, one more than the doc claims.
- **The per-call cap holds. R8 dies** — 50 × 5,000 = 250,000 rows, matching the header.
- **`forced_dry_run` reporting and the success log both die (R9, R10)**, so "the flag is off" is visible in the logs a cron caller never reads — that was my finding 2 from the 22 Sep review and it is genuinely closed.
- **R11 dies**: the batch counter increments *before* the short-batch break, so `batches_run` cannot undercount by one. The comment explains exactly why, which is how it should be.

**The dry run cannot lie.** The report route imports the **same** `levelRetentionCutoffIstDate` as the delete, so "what would be removed" and "what is removed" cannot drift. That was the single most important thing to check on a preview-before-destroy feature, and it is right by construction rather than by coincidence.

### FINDING — the delete path hand-rolls its flag instead of using the repo's one parser

**R2 survives:** replacing `process.env[RETENTION_ENV] === "on"` with a truthiness check leaves the suite green. Nothing pins the strictness.

The code as written is **safe** — I want to be precise about that before anything else. `=== "on"` fails *closed* in every direction: a typo, an unexpected casing, or a different truthy word all leave retention disabled. There is no live danger here.

The finding is that this route does not use `lib/flags.ts`, which exists for exactly this and says so in its own header — *"ONE parser for every on/off environment flag … a second copy of a parser is how two diverge"*:

```
enables:  1 | true | yes | on      (case-insensitive, trimmed)
disables: 0 | false | no | off | "" and unset
anything else THROWS FlagValueError — never read as off
```

Two consequences, both real and neither catastrophic:

1. **An operator following the house convention cannot turn it on.** `BENCH_LEVEL_RETENTION=true`, `=1`, `=yes` or `=ON` all enable a `parseFlag` flag and all leave *this* one disabled. Whoever enables retention will reasonably use the value that works everywhere else, see a `200`, and get a silent dry run — while believing deletion is running and the table is capped. The failure is safe for the data and misleading for the operator, which on a capacity feature means the growth it exists to stop continues unnoticed.
2. **A typo is silently ignored rather than surfaced.** `parseFlag` throws on an unrecognised value precisely so it can never read as "off"; `=== "on"` reads every unrecognised value as off.

**And R2 is why this matters beyond style.** Because nothing tests the strictness, a later tidy-up to `Boolean(env)` or `env ? … : …` — which looks equivalent and is a normal thing to write — would flip the failure direction from safe to **dangerous**: every falsy-intent value, `off` and `false` included, would enable deletion. The current code is correct; there is no test standing between it and that refactor.

**Fix:** `parseFlag(RETENTION_ENV)`. It is the repo's own answer, it throws on a typo instead of silently disabling, and it moves the semantics into one already-tested place so R2 becomes unkillable by refactor rather than merely unkilled today.

### Smaller note

`adminOrSecret` is copied into both route files rather than shared. Identical today; an auth change to one would not reach the other, and one of the two is the delete path.

## Jev — not run

Deliberate, and stated rather than silent: this change is dominated by authorisation and destructive-operation gating, which I verified by execution — eleven targeted mutations against each guard — rather than by design judgement. A scalar score on the diff would add nothing to "does the flag actually gate the DELETE", which is the only question that matters here and which the mutation table answers directly.

## Gate

- **Mine:** 11 mutations through the Yoga fast runner, 0 runner errors, worktree HEAD asserted as `c50ff72` before the run and verified clean after.
- **The builder's:** as recorded in their branch; I did not re-run the full suite.

**Verdict: PASS-WITH-FIXES.** The gating, the authentication on both entry points, the batch caps, the conservative window and the shared-cutoff dry run are all correct and mutation-pinned — this is a careful piece of work on the most dangerous surface I have reviewed today. The one fix is to stop hand-rolling the flag that decides whether any of it deletes, and use the parser the repo wrote for that job.
