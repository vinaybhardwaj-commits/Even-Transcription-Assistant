# ETA-R31 fix round 3 — Builder report · 16 Sep 2026 · worktree `-e18`

Answering `ETA-R31-ROUND2-REFUTATION-16-SEP-2026.md`. Three items: R51, R52, R53. All three built. Small round.

## 1. Commit

`25d640f` on `vinay/e18-silence-is-evidence`, parent `24fcdc2`. Not pushed. `main` untouched. Tree clean.

## 2. Gate, at the final tree state, Docker 29.8.0 up, no exclusions

```
npm run typecheck    tsc --noEmit                      exit 0
npm test             Test Files 112 passed (112)
                     Tests     2718 passed (2718)      exit 0   (was 2712 at 24fcdc2)
npm run build        next build                        exit 0
npm run check:silent Found 9 silent-failure handler(s) exit 0   — the accepted 9, all outside this contract
```

Per R30/R27 no Swift ran and no Swift build is cited. R44 observed: the full gate on this commit.

## 3. Files changed

```
 lib/mcp/tools/stt.ts                       |  12 +++-
 lib/stt/room-drain.ts                      |  18 +++++
 lib/stt/silence.ts                         |  40 ++++++++++-
 tests/unit/e11-silent-room-window.test.ts  |  48 ++++++++++++-
 tests/unit/e18-silence-is-evidence.test.ts | 106 +++++++++++++++++++++++++++++
 5 files changed, 216 insertions(+), 8 deletions(-)
```

Nothing outside the contract moved. **`db/migrations/0101_bench_window_silence.sql` is NOT touched by this
commit** — R50's upgrade block is refuted and out of scope. `lib/stt/room-drain.ts` moved for R52, which the
order contemplates in as many words ("a comment at the exact line"); the 18 lines are comment only, no
behaviour. No OpenSpec change folder exists for E18, so no `openspec validate` line and no `tasks.md` tally
is owed.

## 4. The correction carried

Round 2's report said **"no survivors, no equivalents"**. The tally was right and the word was not. **D2 is a
true equivalent**: with `reopened_as_of` absent from the CREATE TABLE body, the ALTER adds it on the fresh
path as well as the upgrade path, so both paths end with the identical 25-column table and no return value
separates them. I re-ran D2 against this tree and it survives again, correctly. My drift test checks
body → ALTER, which is the direction that can leave an upgraded database short of a column; ALTER → body
cannot hurt and is not checked, deliberately. This is stated in the commit message as ordered.

## 5. R51 — the two numbers, re-measured

```
BUILDER R51 {"preview_windows":1,"unpinned_now":2,"moved":0,"error":"as_of_in_future"}
```

The Refuter measured preview **1**, moved **2**. Now: the operator previews **1**; a second window reaches a
silent verdict, so an unpinned read finds **2**; an apply with tomorrow's date moves **0** and is refused
`as_of_in_future`. Neither window changed state and nothing was stamped — the refusal is before the first
row. The same fixture then applies cleanly with the honest `as_of` and moves its one window, so the refusal
is a fix and not a wall.

**Where the check lives, and why there.** Against the **database's** clock, not the Node process's: the
`as_of` is issued by `now()` inside the preview's own statement, so Postgres is the only clock that can say
whether a bound is in the future, and `Date.now()` would reject a legitimate `as_of` whenever the runtime
lagged Neon by a millisecond. It costs one cheap `SELECT` and is refused at **both** doors — the tool
(`as_of_in_future`, returned) and the module (thrown) — because a pin only a cooperative caller honours is
advisory, which is the whole finding. Refused on the **dry run** as well as the apply, so a fabricated bound
is found while reading. No race in the dangerous direction: an `as_of` that is not in the future cannot
become so.

## 6. R52 — test, not comment; and the comments went in anyway

**TESTED.** The order allowed either, and the ordering IS observable from here: the drain's mocked database
(`tests/unit/e11-silent-room-window.test.ts`) is the drain's own `sql`, so it can be asked what the window's
state was at the instant the verdict row landed, and how many verdict rows existed at the instant the state
moved. Both are asserted in **"R52 — the verdict row is written BEFORE the state moves"**:

- at the state move to `silent`, a verdict row already existed (1);
- at the verdict write, the window was still `transcribing`.

A second case pins the failing branch: `cues_refused` writes no verdict and never reaches `silent`, so the
pair is all-or-nothing in that direction too, which is what makes "silent implies a row" true rather than
merely usual. **Mutant V7 — the state moved to `'silent'` inside `segment` BEFORE the verdict write, which
is the exact reordering nothing else catches — is caught.**

**And the comments, because a test is not where a reader is standing.** The two halves live in different
phases of a job machine, so a reader at either line cannot see the other. Both lines in
`lib/stt/room-drain.ts` now name the dependency, what breaks if it is reversed, and the test that pins it.

**The limit itself is now a measured number in the repo:**
```
BUILDER R52 {"preview_windows":1,"moved":2}
```
Test "R52 — THE LIMIT, MEASURED" reproduces the Refuter's preview 1, moved 2 on a hand-made row and says in
as many words that it is unreachable in production only because of the write order. **Deliberately not
fixed:** the fallback in the bound is R47's mechanism, which this order puts out of scope. Anyone who closes
it has to come to that test and say so.

## 7. R53 / A2 — dead

The module already refused an empty `as_of`; nothing tested it, so removing the throw left the call failing
one layer down on `''::timestamptz` — the database refusing what the module should have refused. The three
`as_of` messages now carry the tool's own names (`as_of_required`, `as_of_invalid`, `as_of_in_future`), so
both doors answer with one vocabulary, and a test pins all four module refusals (empty, whitespace,
unparseable, future) and asserts none of them reached a statement. **A2 is dead** (V5 caught), and so is V6,
the same mutant on the unparseable branch.

## 8. Mutation check

**36 caught of 37 run. One survivor, named: D2, a true equivalent (§4).** Five suites now that the drain's
order is pinned — `e18-silence-is-evidence` on real postgres:16, `e11-silent-room-window`,
`mcp-surface-aliases`, `room-drain`, `migrations-self-record` — baseline **557 of 557**. Rule 22 observed:
each mutation an exact string matched exactly once, sha256 before and after, every file verified restored
(`restored: false` count is 0), no container left running.

- **W1–W29, rounds 1 and 2, re-run and still dead** — the preview's LIMIT, `eligible.total`, the stamp, the
  history, the detector regex at both layers, the 0101 CHECKs in body and ALTER, the as-of bound, the three
  tiebreakers, `RETURNING`, and every statement in the upgrade path.
- **V1** the tool accepting a future `as_of` · **V2** the module accepting one · **V3** the future test
  comparing against a clock two days ahead instead of `now()` · **V4** the refusal softened to a no-op ·
  **V5** A2 · **V6** the unparseable-`as_of` throw removed · **V7** the drain's write order reversed.
- **D2** survived, and is the equivalent named in §4. No other survivor.

## 9. SQL and external-schema assumptions — VERBATIM, all INFERRED (no live database here)

One new statement this round. Everything else is unchanged from `24fcdc2`.

```sql
SELECT ($1::timestamptz > now()) AS future
```

Assumes only that the bound is castable to `timestamptz` (already guaranteed by `Date.parse` upstream) and
that `now()` is the same clock that issued the preview's `as_of`, which it is: both are `now()` on the same
database. No table is read and nothing is written.

## 10. Deviations and flags

1. **R52 was tested AND commented**, where the order said test *or* comment. The comments cost nothing and
   the two halves are in different functions; a reader at one line would otherwise have no way to know the
   other exists. Stated here because the order asked which and why.
2. **The future check is refused at the module as well as the tool**, which the order did not spell out. The
   order's own reasoning — "a bound a caller can widen by fabricating a value is not a bound" — applies to a
   direct module caller identically, and R53 in the same order is about exactly that gap.
3. **Refused on the dry run as well as the apply.** The order names the apply. Refusing on the dry run means
   an operator is told their bound is fabricated while reading rather than after asking for the write, and
   removes the state where a dry run accepts a bound the apply will reject.
4. **Three module error messages changed text** to carry the tool's tokens. `batch`/`reason`/`detector` were
   left in house prose style — not in scope, and changing them would be churn in a refuted area.
5. **NOT DONE, and why: the Refuter's §5 asymmetry.** `as_of_required` returns no preview while the
   unscoped-apply refusal does, and they observe that a caller with no `as_of` is exactly the caller who has
   not previewed. That is a fair point and a one-line change, but it is a flag in their report, not an item
   in this order, and this round was ordered small and precise. Flagged for the next order.
6. **NOT DONE, and why: the no-evidence window is still preview 1, moved 2.** R52 as ordered is a pin, not a
   behaviour change, and the fallback in the bound is R47's mechanism, explicitly out of scope. The limit is
   now a committed, measured test rather than a sentence in a report.
7. **`unrecorded.pre-r31` remains**, as the Refuter flagged it in their §3. Not in this order, not changed.
   Their framing is right and belongs on the record: "every reopened row names a detector" is now true partly
   by construction. The fork — invent a named absence, or drop the history entry — was mine to flag and I
   flagged it in round 2's report §9.7; it is V's or the Orchestrator's to rule on, not mine to revisit.
8. **`lib/stt/room-drain.ts` moved.** Comment only, 18 lines, no behaviour, and V7 proves the drain's
   behaviour is unchanged because the whole suite is green with the comments in and red with the order
   reversed. Say so if that file should not have been touched.

**What had to keep holding, checked:** R47's as-of mechanism (W11/W13/W14/W15 caught, P7 still preview 3 /
moved 3) · R48's ordering in all three statements (W16–W19 caught) · R49's `RETURNING` (W20/W21 caught) ·
0101's upgrade block, untouched by this commit (W22–W28 caught) · R38 and R39 (W3/W4/W5 caught) · R31.5
(W6/W7 caught, no vocabulary added, E13/E15 untouched).

## 11. Migrations and manual steps for V

**None.** 0101 is not touched by this commit and remains committed and **NOT applied to any database**. It
was applied only inside ephemeral `postgres:16` containers during the mutation run; none is left
(`docker ps -a | grep eta` is empty).

## 12. Subagents

None. Every edit, run and measurement in this round is mine.
