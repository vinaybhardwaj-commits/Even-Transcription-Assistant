# ETA-R31 round 3 — Refutation of 25d640f (E18 R51/R52/R53) · 16 Sep 2026 · Refuter (Builder pane)

Delta only: `24fcdc2..25d640f`. R47's as-of mechanism, R48's ordering, R49's RETURNING, R50's upgrade block and D2
were cleared in my round-2 report and were not re-attacked. Work ran in a read-only `git clone --shared` at
`25d640f`; the `-e18` worktree is untouched at `25d640f` and I left no scratch files in it. Migrations ran only in
ephemeral postgres:16 containers, all removed. Rule 22 observed: every mutation restored and verified by sha256.
Per R30/R27 no Swift ran and none is cited. Report on the bus per R33/R40.

## 1. Verdict — MERGE-READY

R52 is not a tautology (V7 dies on the real write order), R53 closes A2 at the module with the tool's own tokens, and
R51 refuses a fabricated bound on both doors. The one thing I would fix next round is a default, not a defect: when
the R51 round trip answers *without rows*, the bound is treated as valid. The realistic outage shape — the round trip
throwing — already fails closed, measured.

## 2. R51 fail-open — measured, not reasoned

I injected the failure into that one round trip and left the rest of the database real.

| The round trip… | Observed |
|---|---|
| **throws** (`connect ECONNREFUSED`) | the error propagates out of `reopenSilentWindows`, the apply never runs, **both windows still `silent`** — **fail-CLOSED** |
| **answers with no rows** | `rows[0]?.future === true` is false, so the bound is accepted: a fabricated *tomorrow* as_of **moved 1 window** — **fail-OPEN** |

At the tool the throw is caught by `failSafe` (registry.ts:74-85), which returns `{ok:false, degraded:true, error}`,
so nothing applies there either. The empty-row path is the one that fails open. **Reachability is low**: `SELECT (x >
now()) AS future` always returns exactly one row from Postgres, so this needs a driver or proxy that reports success
with no rows. But the shape of the guard is "absent answer means permitted", which is the wrong default for a
gate, and it is one line from being `!== false`. Flagged, not blocking.

## 3. R51 completeness — the three cases

| Case | Result | Should it? |
|---|---|---|
| a **future** as_of | **refused on both doors** — module throws `as_of_in_future`, tool answers `{ok:false, error:"as_of_in_future"}` | Yes. Confirmed. |
| a **stale but genuine** as_of (an earlier preview's bound) | **accepted**, moved 2 | **Yes, and it is correct.** An older bound can only narrow the set — it excludes verdicts written since, never admits them. My fixture's second window carried a back-dated `decided_at`, so it sat inside the earlier bound legitimately; that is the fixture, not a leak. |
| an as_of **exactly equal to** `now()` | **accepted** (no refusal; it moved 0 because the set was already empty by then) | Yes. The comparison is strict `>`, and it must be: a preview's own as_of is by definition at or before the apply's clock, so refusing equality would refuse the immediate apply that follows a dry run. |

## 4. R52 — tautology check: it pins the real order

I reversed the **production** order rather than a mock: mutant **V7** moves `state = 'silent'` into the segment step
ahead of `recordSilenceVerdict`. **RED — 1 test.** The pin is on the write order the argument rests on, not on a
fixture's own behaviour. That matters because this is the claim that makes the no-evidence population "fixed", which
is what my round-2 finding about the unpinned no-evidence window was downgraded on.

## 5. R53 — both refusals, at the module, before any statement

Empty as_of → `as_of_required`, **0 statements executed**. Unparseable → `as_of_invalid`, **0 statements executed**.
Nothing reaches a statement in either case, and the window stayed `silent`. Last round's A2 survivor is dead (V5
caught), V6 is caught on the unparseable branch, and all three module messages carry the tool's own tokens (R53-a/b/c
each caught when the token is dropped).

## 6. Scope — `lib/stt/room-drain.ts` is comment-only

18 lines added, 0 removed, and every added line is a comment: filtering the diff for non-comment changes returns
nothing. No behaviour changed anywhere in that file.

## 7. The §5 asymmetry — observable, and it does not matter

An operator can see it: `as_of_required` answers `{ok:false, error, detail}` with no `would`, while the unscoped
refusal still carries its preview. It costs nothing, because a caller with no as_of has not run the dry run that
mints one, so the only way forward is the dry run they skipped — the missing preview saves a round trip rather than
hiding anything.

## 8. My own mutation run on the delta: 9 caught of 11

Four suites per mutant (e18-silence-is-evidence and room-drain on real postgres:16, e11-silent-room-window,
mcp-surface-aliases), baseline 461 of 461.

**Caught (9):** V7 (the real write order reversed) · R51-a (the check always answers "not in the future") · R51-d
(the module stops refusing) · R51-e (the tool stops refusing) · V5 · V6 · R53-a · R53-b · R53-c.

**Survivors (2), both on R51's edges, neither an equivalent:**
- **R51-b — the bound compared against `Date.now()` instead of the database clock.** A real separator exists and it
  is the exact scenario the code's own comment gives as the reason for the choice: a runtime lagging Neon would
  reject a legitimate as_of. Nothing pins it, so the reasoning is sound and untested. A test would need a skewed
  clock, which is why it is absent — worth a line of test with an injected clock, not a rebuild.
- **R51-c — `>` becomes `>=`, refusing an as_of exactly equal to `now()`.** Separable in principle (the boundary
  case in §3), but Postgres `now()` has microsecond resolution and the apply is always a later statement, so the
  equality is near-unreachable in production. Closest thing to an equivalent in this set, and I am not calling it
  one.

## 9. Gate — rerun by me, Docker up, no exclusions

`npm run typecheck` exit 0 · `npm test` **`Test Files 112 passed (112)`, `Tests 2718 passed (2718)`** ·
`npm run build` exit 0 · `npm run check:silent` exit 1 with the accepted pre-existing 9. This reproduces the
builder's numbers exactly.

## 10. Anything unrun
- Swift: not run, not cited (R30/R27) — no Swift file is touched by this delta.
- A real database outage (container stopped) was not used: the harness's container is `--rm`, so stopping it would
  destroy the fixture I needed to check afterwards. I injected the failure into the single round trip under test
  instead and left every other statement against the live database; that isolates the question the order asked.
- 0101 applied only inside ephemeral containers; it remains committed and unapplied.
- The live silent-window population was not measured: no database in this pane.

## 11. Scratch evidence (session scratchpad, not committed)
`r3/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`. The probe file `tests/unit/zz-refuter-r3.test.ts` ran in the clone and was deleted after.

## 12. Subagents
None.
