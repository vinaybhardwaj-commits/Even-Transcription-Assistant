# ETA-R31 — Refutation of fea3f81 (the E18 operator surface) · 16 Sep 2026 · Refuter (Builder pane)

Worktree `-e18`, branch `vinay/e18-silence-is-evidence`, HEAD `fea3f81` on `56320ba`. I did not review E18 itself.
Nothing was fixed, committed, pushed, merged or promoted; 0101 was applied only inside ephemeral postgres:16
containers. I ran the gate, the probes and the mutants in a read-only `git clone --shared` of the worktree at
`fea3f81`, and per R33 this report lands on the bus in the main worktree. Per R30 no Swift ran and no Swift build is
offered as evidence.

## 1. Verdict — NOT MERGE-READY

The design is right and the guards hold: the dry run really is the default, every refusal happens before a row
moves, and the tool classifies nothing. It fails on the one thing the brief says matters most — **the preview is not
honest**. It counts a set the apply will not touch, and it counts windows the apply moves without recording that it
did. Three of the five items pass cleanly; two do not.

## 2. IS THE PREVIEW HONEST? No — it over-counts by default, and it under-records

**P1 — the preview ignores `limit`; the apply is bounded by it.** `previewSilenceReadjudication` has no `LIMIT` in
its SQL (`lib/stt/silence.ts:274-300`), while `reopenSilentWindows` takes `capped(f.limit, 100, 1000)`
(`silence.ts:355`). The tool hands the *same* filter object to both (`lib/mcp/tools/stt.ts:486-488`), so the limit is
carried into the preview and then discarded. Measured on postgres:16, 250 silent windows, default call:

```
REFUTER P1 {"preview_windows":250,"apply_reopened":100,"silent_left":150}
```

The operator reads `would.windows: 250`, passes `apply: true`, and 100 windows move. On the production backlog this
is the difference between "re-adjudicate 4,000 windows" and a run that touches 100. `scope.limit` is echoed beside
it, so the number is recoverable — but `would` is the field that names the population, and it names the wrong one.
**A dry run that miscounts is worse than no dry run, because it licenses an apply.** Either the preview must apply
the same `LIMIT`, or `would` must carry both numbers (matched and would_move).

**P2 — windows with no evidence row are moved with no ledger entry at all.** Both statements `LEFT JOIN`
`bench_window_silence`, so a silent window with no evidence row is previewed *and* moved. But the `stamped` CTE is an
UPDATE of that same table, so there is nothing to stamp. Measured, three such windows:

```
REFUTER P2 {"preview_windows":3,"preview_no_evidence_row":3,"apply_reopened":3,"windows_moved":3,"ledger_rows_stamped":0}
```

The function's own comment says "a window can never be re-offered with nothing recording why". For this population —
which the preview itself highlights as `no_evidence_row`, and which 0101's header calls the real production shape —
that is false. They are also eligible again immediately (`z.reopened_at IS NULL` is true when there is no row), so
the same windows can be re-opened on every pass, silently, for ever.

**Preview and apply agree on the set; they disagree on the size (P1) and on what gets recorded (P2).**

## 3. Can anything apply without the explicit opt-in? No

Enumerated from the code, not the description:
- `reopenSilentWindows` and `previewSilenceReadjudication` have exactly one caller each in `lib`, `app` and
  `scripts`: the tool itself (my own grep). No cron, no route, no drain hook.
- The tool is reached only through the MCP door, which authenticates, scopes (`scope: "write"`) and audits.
- `argBool` (`lib/mcp/registry.ts:122-125`) accepts only `true`, `"true"` and `1`. `apply: "false"`, `apply: 0` and
  `apply: "yes"` all stay a dry run — it fails safe.
- The three refusals (detector, reason, unscoped) all return before `reopenSilentWindows` is called, and mutants R1-R4
  confirm each is load-bearing.

## 4. Does the ledger distinguish runs? Across sets yes; on a window touched twice, no

**P3, measured:** a window re-adjudicated by `detector_A` (batch_A), called silent again by the drain, then
re-adjudicated by `detector_B` with `include_reopened: true`:

```
REFUTER P3 {"second_reopened":1,"ledger_now":{"reopened_batch":"batch_B","reopened_reason":"second pass","reopened_detector":"detector_B"}}
```

The row holds only the latest pass. `detector_A` is gone — not just its name, but the fact that this window was
re-adjudicated before. R31.3's purpose ("the fact that one verdict overwrote another is lost with it") is met between
*batches* and lost *within a window*. The ledger is last-writer-wins with no history. Combined with P2, the windows
with no evidence row have no ledger at all.

## 5. Does it classify? No — confirmed

**P4, measured:** the caller's string is stored verbatim, trimmed only.
`{"given":"  NOT-A-DETECTOR: <script>  ","stored":"NOT-A-DETECTOR: <script>","returned":"NOT-A-DETECTOR: <script>"}`.
The tool derives nothing, calls no detector, and reads no level to decide anything. E13 and E15 are untouched. R31.5
holds. (The stored string is unvalidated free text, which is the correct choice here — inventing a vocabulary would
be the smuggled classifier — but it means the ledger's detector column is only as disciplined as its callers.)

## 6. Rule 21 — what the fixtures and the surface still cannot express

- **The surface names the ambiguity but cannot resolve it inside the levelled set.** `level_recorder` /
  `level_absent` / `no_evidence_row` tell a caller how many verdicts rest on no measurement at all — the honest part.
  But for the windows that *do* carry a level, the preview reports no level values (no peak/avg distribution, no
  "flat zero" count), so a quiet room and a dead mic are one number there too. It does not flatten the
  present-vs-absent distinction; it flattens everything inside "present".
- **No fixture covers the preview/apply size disagreement** (P1) or the no-evidence ledger hole (P2): both are
  invisible to the suite, which is how they survived.
- **No fixture re-adjudicates an already-re-adjudicated window** to see what the ledger keeps (P3).
- **No fixture drives the tool with a set larger than `limit`.**
- The preview's `by_verdict`/`by_engine` roll-ups are built from a second query with its own filter copy; nothing
  asserts the two queries stay in step, so a future edit to one can drift from the other.

## 7. Mutation check: 12 caught of 14 run

Four suites per mutant (e18-silence-is-evidence on real Postgres, mcp-surface-aliases, room-drain,
migrations-self-record), baseline 514 of 514. Each mutation was applied by an exact string matched once and restored
under a sha256 check.

**Caught (12):** R1 a plain call applies (2) · R2 apply without a detector · R3 without a reason · R4 unscoped
without all_rooms (2) · R5 the batch does not name the detector · R6 the ledger does not record it (6) · R7 the bulk
path accepts an empty detector · R8 0101's CHECK dropped · R9 every window counted as levelled · R10 the preview
offers already-reopened windows · R11 a new verdict inherits the old stamp (8) · X2 the preview reports no missing
evidence rows. **scribe's eleven all reproduce as claimed.**

**Survivors (2), both mine, both with a real separator:**
- **X1 — the apply's `LIMIT` removed.** A set larger than `limit` separates them: the tool advertises
  "caps how many windows apply moves", and nothing tests that it does. (Ironically the mutant makes the preview
  honest — it is the same gap as P1, seen from the other side.)
- **X3 — the `stamped` CTE stamps every row in `bench_window_silence` instead of only the moved ones.** Any window
  beyond the limit or outside the scope separates them: it would be stamped with a batch, reason and detector while
  never having been handed back — a false ledger entry, and the exact thing the comment says cannot happen
  ("a stamp can never name a window that was not moved"). No test covers it.

No equivalents.

## 8. Findings

- **The preview over-counts by default: it ignores `limit`, the apply does not (250 previewed, 100 moved).**
- **Windows with no evidence row are moved with zero ledger rows written**, and stay eligible for every later pass.
- Nothing can apply without `apply: true`; `argBool` is strict, the only caller is the tool, and every refusal precedes the first write.
- The ledger distinguishes batches but keeps only the latest pass per window: a second re-adjudication erases the first.
- The tool classifies nothing — the detector string is stored verbatim; E13/E15 untouched.
- The surface can say how many verdicts have no level; it cannot separate a quiet room from a dead mic among those that do.
- X1 and X3 survive: the `limit` bound and the "stamp only what moved" promise are both untested.
- Gate reproduces the commit's claim exactly: typecheck 0, `Tests 2698 passed (2698)` across 112 files with Docker up, build 0, check:silent the accepted 9.

## 9. Anything unrun
- Swift: not run, and not cited (R30, R27). No Swift file is touched by this diff.
- 0101 applied only in ephemeral containers; it remains committed and unapplied.
- The live silent-window population was not measured — this pane has no database.

## 10. Scratch evidence (session scratchpad, not committed)
`r31/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`, and the probe file `tests/unit/zz-refuter-r31.test.ts` (P1–P4), which exists only in the
clone.

## 11. Subagents
None.
