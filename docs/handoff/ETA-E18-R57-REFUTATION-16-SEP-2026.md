# ETA-E18 R57 — Refutation of a41a463 · 16 Sep 2026 · Refuter (Builder pane)

Delta only: `ab5cb44..a41a463` — `db/migrations/0101_bench_window_silence.sql`, `lib/stt/silence.ts` and its test.
R47–R55, D2 and R51-c were cleared in earlier rounds and were not re-attacked. Work ran in a read-only
`git clone --shared` at `a41a463`; the `-e18` worktree is untouched at `a41a463` and I left no scratch file in it.
The one migration file I mutated by hand was restored and verified by sha256 (`OK`). Containers all removed. Per
R30/R27 no Swift ran and none is cited.

## 1. Verdict — MERGE-READY

The sentinel cannot be minted through either door, the CHECK admits it by literal rather than by pattern, and no
reader anywhere shape-checks a value it read back. This closes the one item I left open at ab5cb44.

## 2. The reader claim — I searched wider, and found no reader it missed

scribe searched `lib`, `app` and `scripts`. I searched the **whole repository** — every `.ts`, `.tsx`, `.mjs`,
`.js`, `.sql`, `.py`, `.sh`, `.json`, `.swift`, `.yml`, `.txt`, excluding only `node_modules` and `.git`:

- **`DETECTOR_NAME` appears at exactly two production sites** — `lib/stt/silence.ts:507` and
  `lib/mcp/tools/stt.ts:521` — both testing `detector`, the caller's own argument. Every other mention is a test,
  a comment, or the migration's prose.
- **Nothing outside `lib/stt/silence.ts` and `0101` reads `reopened_detector` or `reopened_history` at all.** The
  only SELECTs of those columns in the repo are in the e18 test file.
- It is in fact stronger than claimed: `listSilentWindows`, the one reader of the silence table's reopen columns,
  selects `reopened_at` and `reopened_batch` **and not the detector** — and it has no caller in `lib` or `app` yet,
  so no surface returns a stored detector to anyone.
- No Swift, Python, shell, YAML or JSON file mentions the column.

**No missed reader.** The unmintable spelling cannot break on read, because nothing reads it through the shape rule.

## 3. Unmintability — every attempt refused, on both doors

| detector offered | module | tool |
|---|---|---|
| `(unrecorded.pre-r31)` | refused: not a usable name | `detector_name_invalid` |
| `(unrecorded.pre-r31` | refused | `detector_name_invalid` |
| `unrecorded.pre-r31)` | refused | `detector_name_invalid` |
| `  (unrecorded.pre-r31)  ` (padded) | refused | `detector_name_invalid` |
| `(UNRECORDED.PRE-R31)` | refused | `detector_name_invalid` |
| `(a)` | refused | `detector_name_invalid` |

Nothing moved: the window stayed `silent` through all six. And the **old spelling is still an ordinary name** —
`unrecorded.pre-r31` was accepted, moved 1, and is stored verbatim as a caller's detector. That is exactly why it
could not serve as a sentinel, and it still cannot be confused with one.

## 4. By literal, not by pattern — confirmed

Against the CHECK directly: `(unrecorded.pre-r31)` **ACCEPTED**; `(something.else)` refused;
`((unrecorded.pre-r31))` refused; `()` refused; `two words` refused; `e13_deadmic_v1` accepted. Every refusal names
`bench_window_silence_detector_chk`. Mutant S2 — the same CHECK widened to admit any parenthesised string by
pattern, in both copies — is **caught**, so the by-literal property is pinned and not merely present.

## 5. R50 re-run against this version — all three parts hold

1. **Upgrade:** previous committed blob (`ab5cb44`'s 0101), then this one on top → 25 columns including
   `reopened_as_of`, 8 CHECKs, and the detector CHECK carries the sentinel literal.
2. **Idempotent:** a second application leaves columns and constraint definitions byte-identical.
3. **Legacy repair:** from the ORIGINAL shape (`56320ba`, which has no detector column), a row reopened before the
   ledger had a detector is repaired to `(unrecorded.pre-r31)` — matching the module's exported constant — with the
   pass preserved in history. With the backfill removed the migration **fails loudly**:
   `ERROR: check constraint "bench_window_silence_detector_chk" … is violated by some row`.

## 6. My own mutation run on the delta: 5 caught of 5, no survivors

Two suites per mutant (e18-silence-is-evidence on real postgres:16, mcp-surface-aliases), baseline 398 of 398.
**Caught:** S1 (the backfill writes the mintable spelling again) · S2 (the CHECK admits parentheses by pattern) ·
S3 (the module's constant drifts from the migration's literal) · S4 (`DETECTOR_NAME` widened to permit parentheses,
making the sentinel mintable) · S5 (the CHECK stops constraining the detector's shape at all). No equivalents.

## 7. Gate — rerun by me, Docker up, no exclusions

`npm run typecheck` exit 0 · `npm test` **`Test Files 112 passed (112)`, `Tests 2721 passed (2721)`** ·
`npm run build` exit 0 · `npm run check:silent` exit 1 with the accepted pre-existing 9.

## 8. The final answer

**`vinay/e18-silence-is-evidence` at `a41a463` is merge-ready into `vinay/s1-auto-drain`. Without qualification.**

Across four rounds every defect I measured has been closed and pinned, and I killed each fix's mutant myself rather
than reading a tally: the preview's bound, the ledger hole for no-evidence windows, the overwritten pass, the
untotal order, the picked/moved divergence, the migration that would have succeeded and done nothing, the fabricated
future bound, the fail-open default, and now the collision between the backfill sentinel and a caller-suppliable
name. The one item I asked you to rule on consciously at ab5cb44 — the invented token — is no longer a judgement
call: the stored set and the caller-suppliable set are disjoint by construction, and the ledger can no longer be
made to say something a caller could also have said. **Nothing outstanding.**

## 9. Anything unrun
- Swift: not run, not cited (R30/R27) — no Swift file is touched.
- 0101 applied only inside ephemeral containers; it remains committed and unapplied.
- The live silent-window population was not measured: no database in this pane.

## 10. Scratch evidence (session scratchpad, not committed)
`r5/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`. The probe file `zz-refuter-r5.test.ts` ran in the clone and was deleted after.

## 11. Subagents
None.
