# ETA-R31 fix — Refutation of 0d21596 (E18 R37/R38/R39) · 16 Sep 2026 · Refuter (Builder pane)

Worktree `-e18`, branch `vinay/e18-silence-is-evidence`, HEAD `0d21596` on `fea3f81`. I measured the three defects
this commit fixes; I did not build the fixes and I reran everything. Work was done in a read-only `git clone --shared`
at `0d21596`; per R33/R40 the report is on the bus. Nothing was fixed, committed, pushed, merged, promoted or
applied outside ephemeral postgres:16 containers (Docker 29.8.0). Per R30/R27 no Swift ran and none is cited. I did
not touch the id tokens in public history (E29) and did not review the E16 merge.

## 1. Verdict — MERGE-READY, with one wording correction and one item for the next round

All three defects I raised are fixed, and each is pinned by a test that fails without the fix. What is not true is the
unqualified phrase **"equal BY CONSTRUCTION"**: the preview and the apply are two statements at two times, and I made
them disagree in both directions (§2). That is a weaker class than the defect it replaced — which was wrong on every
call — but it is the same failure mode, so it belongs on the record rather than in a comment that says it cannot
happen.

## 2. IS THE PREVIEW HONEST NOW? Yes for the bound. No across time.

**The bound is fixed, exactly as claimed.** My original measurement, rerun:

```
REFUTER P1 {"preview_windows":100,"eligible_total":250,"moved":100,"remaining_eligible":150}
```

`would.windows` is now what this call moves, `eligible.total` is what matches altogether, and they come from one
statement, so they cannot drift from each other. An empty set and a scope matching nothing both answer cleanly:
`{"empty_windows":0,"empty_total":0,"empty_first":null,"by_verdict":[],"scoped_total":0,"moved":0}`.

**Across time, they still disagree — measured, both directions.**

| Probe | What happened between preview and apply | Result |
|---|---|---|
| P3 | one window left the silent set (the drain re-ran it) | preview **5**, moved **4** |
| P7 | two more windows became silent, inside the same scope | preview **3**, moved **5** — the apply moved windows the preview never described |

P7 is the one that matters: the apply is not bounded by what the operator read, only by the same filter re-evaluated
later. In a live clinic the drain writes silent verdicts continuously, so between a dry run and the apply the set
moves by construction. The apply re-checks `state = 'silent'`, so nothing wrong is moved, and the cap bounds the blast
radius — but "the preview licensing an apply it does not describe" is still reachable. **The surface has no way to
apply exactly what was previewed** (no window-id list, no as-of bound). That is the next round's item, not a defect in
what this commit claims to do.

## 3. Findings

- **R37 fixed:** preview 100 / eligible 250 / moved 100 / remaining 150, from one statement. Z1 (the preview drops its
  LIMIT) and Z2 (eligible.total reports the bounded set) are both caught.
- **R38 fixed:** a no-evidence window now gets its first ledger row — `{verdict: null, reopened_batch: "batch_A",
  reopened_detector: "detector.A", history length 1}` — and then drops out of the eligible set (`eligible.total` 0
  after two passes, where it used to stay silently re-openable). Z3 is caught.
- **R39 fixed:** two passes are both on the record, in order: `[{batch: batch_A, detector: detector.A}, {batch:
  batch_B, detector: detector.B}]`, with the scalars naming the latest. Z4 (history overwritten) and Z5 (a fresh
  verdict erasing history) are both caught. **I could not make two passes collapse to one record.**
- **The CHECK holds under every writer.** `bench_window_silence` has exactly two: `recordSilenceVerdict` (sets all
  four evidence columns, clears the reopen scalars, leaves history) and the stamp UPSERT (sets `reopened_at` and at
  least one history entry). Row-kind and history are satisfied on both paths and on the conflict branches; the
  verdict path cannot strand a reopened row without history because it nulls `reopened_at` in the same statement.
  Z8 and Z9 confirm both CHECKs are load-bearing.
- **The detector name is constrained in shape only** — the regex admits any vocabulary, so R31.5 still holds and no
  classifier is smuggled in. Z6 and Z7 are caught at both layers.
- **TOCTOU (§2), unchanged by this commit and now the sharpest edge left.** Recommend the next round pins the set:
  apply takes the previewed ids, or a `preview_token`/as-of bound, so an apply can only ever move what was shown.
- **The order is not total.** `ORDER BY start_ms ASC` has no tiebreaker, so among windows sharing a start the
  membership of the picked set is planner-dependent. I could not make it diverge on a small fixture (three runs chose
  the same room), so this is latent rather than measured — but it is what mutant Z10 exposes.
- **0101 cannot upgrade a database that already has its earlier shape.** The table is `CREATE TABLE IF NOT EXISTS`
  with the new columns inside the body and no `ALTER ... ADD COLUMN` for `reopened_history` or the nullability
  changes. 0101 is unapplied everywhere, so this costs nothing today; it means the file is idempotent only against a
  database that has never seen its previous version.
- **Gate reproduces the claim:** typecheck 0, `Tests 2702 passed (2702)` across 112 files with Docker up and no
  exclusions, build 0, check:silent the accepted 9.

## 4. Rule 21 — what the fixtures still cannot express

- The E18 limit stands and the surface still cannot resolve it: `level_recorder` / `level_absent` /
  `no_evidence_row` say how many verdicts rest on no measurement, but no level values are reported, so inside the
  levelled set an empty room and a dead mic remain one number. The surface names the ambiguity; it cannot resolve it,
  and this commit does not claim to.
- No fixture changes the world between the preview and the apply (§2), which is why both directions survived to be
  found here.
- No fixture has two windows sharing a `start_ms`, so the tie behaviour is unexercised.
- No fixture has a second caller, so nothing covers two operators applying concurrently.

## 5. Mutation check: 10 caught of 12 run

Four suites per mutant (e18-silence-is-evidence on real Postgres, mcp-surface-aliases, room-drain,
migrations-self-record), baseline 518 of 518. Each mutation was applied by an exact string matched once and restored
under a sha256 check.

**Caught (10):** Z1 preview without its LIMIT · Z2 eligible.total bounded · Z3 the stamp back to UPDATE-only ·
Z4 history overwritten · Z5 a verdict erasing history · Z6/Z7 the detector name unconstrained (module, tool) ·
Z8 the row-kind CHECK dropped · Z9 the history CHECK dropped · Z11 a stale `remaining_eligible`.
**scribe's X1 and X3 reproduce as dead** — Z1 and Z3 are their shapes, and both fail loudly now.

**Survivors (2), both mine, both with a real separator, neither an equivalent:**
- **Z10 — the apply's `ORDER BY start_ms ASC` removed.** A matching set larger than the limit separates them: the
  preview would describe the earliest windows and the apply would move an arbitrary subset of the same size. Nothing
  tests that the two orders agree; the pairing rests on both statements carrying the same clause, and only one of
  them is pinned.
- **Z12 — the stamp writes over `picked` instead of `moved`.** Separable only under concurrency: within one statement
  the two sets are identical, but a concurrently committed state change makes `moved` skip a row that `picked` still
  holds, and that window would get a ledger entry saying it was handed back when it was not. The X3 test covers
  windows outside the scope, not this.

## 6. Anything unrun
- Swift: not run, not cited (R30, R27).
- 0101 applied only inside ephemeral containers; it remains committed and unapplied.
- The live silent-window population was not measured — no database in this pane.
- Two operators applying concurrently was not simulated; §5's Z12 is reasoned from Postgres's read-committed
  behaviour, not measured.

## 7. Scratch evidence (session scratchpad, not committed)
`r31fix/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`, and the probe `tests/unit/zz-refuter-r31fix.test.ts` (P1–P7), which exists only in the clone.

## 8. Subagents
None.
