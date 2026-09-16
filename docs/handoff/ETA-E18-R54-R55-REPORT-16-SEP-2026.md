# ETA-E18 R54/R55 — the future-bound check fails closed, and the clock behind it is pinned · 16 Sep 2026 · Builder

Worktree `-e18`, branch `vinay/e18-silence-is-evidence`, commit **`ab5cb44`** on `25d640f`. Answering
`ETA-R31-ROUND3-REFUTATION-16-SEP-2026.md`, whose verdict was MERGE-READY with these two items outstanding.
Nothing was merged, pushed, promoted or deployed; no migration was applied anywhere, ephemeral containers
included; the main worktree was entered only to write this document.

## R54 — the guard defaulted open, and now refuses an answer it cannot read

`asOfIsInFuture` read `rows[0]?.future === true`. With no rows that expression is `false`, so an unverified
bound was treated as legitimate and the Refuter measured a fabricated *tomorrow* as_of **moving 1 window**. The
shape is now `rows[0]?.future !== false`: only an explicit negative from the database admits a bound, and an
absent answer refuses.

Postgres always returns exactly one row for `SELECT (… > now()) AS future`, so reaching this needs a driver or
proxy that reports success with nothing in it. The test therefore induces the anomaly **at the driver
boundary** — the future check alone answers no rows, every other statement runs for real — because what is
under test is the shape of the guard, not Postgres's row-count behaviour.

**The Refuter's own probe, re-run: MOVED = 0.** Both doors refuse by name (`as_of_in_future` from the tool, the
same name thrown by the module), the window stays `silent`, and no ledger row claims it was handed back. Under
the old `=== true` shape the test fails with "expected ok:true … to match ok:false".

## R55 — the clock choice was reasoning; it is now a test

The as_of is minted by `now()` inside the preview's own statement, so the database is the only clock that can
judge it. Comparing against `Date.now()` would reject a legitimate bound whenever the app runtime lagged Neon —
a real gap between a serverless runtime and Neon, not a hypothetical one. Nothing separated the two clocks, so
mutant **R51-b passed everything**.

The new test freezes **this process's** `Date` an hour behind the database, asserts the skew is real and in the
direction that matters (the database's bound looks future-dated to Node), then applies the preview's own bound:
**accepted, one window moved**. Under a `Date.now()` comparison the same bound reads an hour into the future and
the apply refuses — the mutant dies there.

## Accepted survivor, named rather than fixed

**R51-c — `>` becoming `>=`.** Strict `>` is correct and stays. An as_of exactly equal to `now()` must be
accepted, or an apply run straight after its own dry run would refuse itself. The boundary is one microsecond
wide and the behaviour it would change is the legitimate case.

## Mutation check — 5 caught of 6 run

Three suites per mutant (`e18-silence-is-evidence` on real Postgres, `mcp-surface-aliases`,
`e11-silent-room-window`), baseline 422 of 422. Files were checksummed before mutating and verified after; no
container was left behind.

**Caught (5):** R51-a the check always answering "not in the future" · **R54** the fail-open shape · **R51-b**
the Node clock · R51-d the module's check removed · R51-e the tool's check removed.
**Survivor (1):** R51-c, accepted above, with a real separator that we do not want to change.
**Equivalents: none.**

## Gate

`npm run typecheck` 0 · tests typecheck 0 · `npm test` **112 files, 2720 tests passed**, Docker up, no
exclusions · `npm run build` 0 · `npm run check:silent` the accepted 9. Per R30/R27 no Swift file is touched, so
`swift test` was not run and no Swift build is offered as evidence.

## Not done

Nothing else in the refutation was touched: R47, R48, R49, R50, R52 and R53 stand as they were, 0101 remains
committed and **not applied**, the E16 line (`d861abf`) was not approached, and the eleven id-shaped tokens in
public history remain V's decision (`ETA-E29-ID-TOKENS-IN-PUBLIC-HISTORY-16-SEP-2026.md`).
