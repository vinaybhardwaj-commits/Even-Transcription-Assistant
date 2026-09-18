# ETA-R31 fix round 2 — Builder report · 16 Sep 2026 · worktree `-e18`

Answering `ETA-R31-FIX-REFUTATION-16-SEP-2026.md`. Four items: R50, R47, R48, R49. All four built.

## 1. Commit

`24fcdc2` on `vinay/e18-silence-is-evidence`, parent `0d21596`, worktree
`/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-e18`. Not pushed. `main` untouched.

## 2. Gate, at the final tree state, Docker 29.8.0 up, no exclusions

```
npm run typecheck    tsc --noEmit                      exit 0
npm test             Test Files 112 passed (112)
                     Tests     2712 passed (2712)      exit 0   (was 2702 at 0d21596)
npm run build        next build                        exit 0
npm run check:silent Found 9 silent-failure handler(s) exit 0   — the accepted 9, all outside this contract
```

Per R30/R27 no Swift ran and no Swift build is cited. The gate was re-run in full after the
`TOOL-NOTES.md` edit; per R44 there is no docs-only exemption.

## 3. Files changed

```
 db/migrations/0101_bench_window_silence.sql | 100 ++++++-
 docs/operator-mcp/TOOL-NOTES.md             |   7 +-
 lib/mcp/tools/stt.ts                        |  35 ++-
 lib/stt/silence.ts                          | 123 +++++++--
 tests/unit/e18-silence-is-evidence.test.ts  | 390 ++++++++++++++++++++++++++--
 5 files changed, 607 insertions(+), 48 deletions(-)
```

Nothing outside the contract moved. This repo has no OpenSpec change folder for E18, so no
`openspec validate` line and no `tasks.md` tally is owed.

## 4. R50 — 0101's upgrade test

**The defect, confirmed as stated.** Every column added after the first draft of 0101 lived inside
`CREATE TABLE IF NOT EXISTS` with no `ALTER`. On a database already holding an earlier shape the migration
succeeds and does nothing, and the code then fails on missing columns. A fresh-database test cannot see it.

**The fix.** An UPGRADE PATH block after the CREATE TABLE:
- `ADD COLUMN IF NOT EXISTS` for **every** column in the body, no exception list — 25 statements;
- `DROP NOT NULL` on `verdict`, `engine`, `audio_level_source`, `vad_params_source` (R38 needs a ledger-only row);
- a **backfill before the CHECKs**, because `detector_chk` and `history_chk` are refused by rows that predate
  them: a pass recorded under the earlier shape has no detector and no history, and the fact was never written
  down, so it is named `unrecorded.pre-r31` and its history reconstructed from its own scalars. Inventing a
  real detector name would be the classifier R31.5 forbids; this is the same move the table already makes with
  `audio_level_source='absent'`;
- `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` for the three CHECKs added after the first draft.

**Test result — PASSES.** Three Docker tests apply the migration to a database holding the FIRST DRAFT of
0101 (56320ba's shape, frozen in the test file, in its own `upgrade_probe` schema) carrying a legacy
re-adjudication row: the columns arrive, the four NOT NULLs lift, the three CHECKs exist, the legacy row is
backfilled and not lied about (`reopened_as_of` stays NULL — an unbounded pass really was unbounded), R38's
ledger-only insert is accepted on the upgraded table, and the row-kind CHECK still refuses a row that is
neither. Two further tests read the `.sql` with no database and assert the rule mechanically, so the next
column added to the body alone is caught without one.

## 5. P7 after the fix — the numbers

```
BUILDER P7 {"preview_windows":3,"unpinned_now":5,"moved":3,"as_of_pinned":true}
```

The Refuter measured preview **3**, moved **5**. Now: the operator previews **3**; two windows then reach a
silent verdict inside the same scope, so an unpinned read finds **5**; the apply, handed the preview's own
`as_of`, moves **3**. The two newcomers stay `silent`. Replaying the same `as_of` on a dry run returns 0 —
the pin is reproducible, not merely assertable.

The fixture matters and was corrected mid-round: the two late windows are **created and closed before** the
preview and only their **verdict** lands after it, which is the production shape. A fixture that created them
after the preview passed against a bound read off the window's age instead of its verdict, and proved nothing
(mutant W15 caught it).

## 6. Z10 and Z12 — fail-before, pass-after

| | fail-before | pass-after |
|---|---|---|
| **Z10** (W16, the apply's `ORDER BY` removed) | caught — 90 windows, limit 30, inserted in DESCENDING start order so a scan that ignores the clause returns the wrong thirty | suite green |
| **Z12** (W20, the stamp written over `picked`) | caught — the statement no longer resolves: `picked` selects `w.id` alone and the ledger's `session_id`/`room_day_id` come only from the UPDATE's `RETURNING` | suite green |

Z12 is closed by a property rather than a test for a violation: `RETURNING` carried everything the stamp
needed, so no second statement was reached for, and pointing the INSERT at `picked` is now not expressible.
W21 (the UPDATE narrowed back to `RETURNING w.id`) is also caught, which is what keeps that property.

## 7. Mutation check

**29 caught of 29 run. No survivors. No equivalents.** Four suites
(`e18-silence-is-evidence` on real Postgres, `mcp-surface-aliases`, `room-drain`,
`migrations-self-record`), baseline **527 of 527**. Each mutation an exact string matched exactly once,
sha256 before and after, every file verified restored, no container left running.

- **W1–W10, carried forward and still dead:** the preview's LIMIT · `eligible.total` bounded · the stamp back
  to UPDATE-only · history overwritten · a verdict erasing history · the detector name unconstrained at module
  and tool · both new CHECKs in the 0101 body · a stale `remaining_eligible`.
- **W11–W15, R47:** the apply's as-of bound removed · the tool no longer requiring an `as_of` · the preview
  ignoring a handed-back one · the ledger not recording the bound · the bound read off the window's age
  instead of its verdict.
- **W16–W19, R48:** the apply's ORDER BY removed · the tiebreaker removed in the apply, in the preview and in
  `listSilentWindows`.
- **W20–W21, R49.** **W22–W27, R50** (each new ADD COLUMN, the DROP NOT NULL, the backfill, the CHECK re-add).
- **W28** the ALTER copy of a CHECK weakened. **W29** the tool dropping the `as_of` on a dry run.

**Three survived the first pass and each got a test, not an excuse.** For each, a real return value separates
the two conditions:
- **W8/W9** (the row-kind and history CHECK weakened in the CREATE TABLE body) survived because the new ALTER
  block repairs a weakened body on every database, fresh or upgraded. That makes the body's copy a duplicate
  free to drift from the ALTER — the very class R50 is about — so a test now normalises both predicates and
  asserts they are the same text. Not equivalents once that test exists; before it they were, and they were
  equivalents **created by this round's own fix**, which is worth the Refuter's attention.
- **W15** (the bound read off `created_at` instead of `decided_at`) survived because my P7 fixture created
  the late windows after the preview. The separator is the production shape: a window created and closed long
  before the drain reaches it, whose verdict alone lands late. Fixture corrected; mutant now caught.

## 8. SQL and external-schema assumptions — VERBATIM, all INFERRED (no live database here)

New or changed this round. Everything else in `lib/stt/silence.ts` is unchanged from `0d21596`.

**a. The bound, identical in the preview and the apply:**
```sql
COALESCE(z.decided_at, w.closed_at, w.created_at) <= b.as_of
```
Assumes `bench_window_silence.decided_at` (0101), and `bench_window.closed_at` / `bench_window.created_at`
(0057, `created_at` NOT NULL). The fallbacks only ever apply to a window with no evidence row.

**b. The preview's bound CTE:**
```sql
WITH bound AS (SELECT COALESCE($n::timestamptz, now()) AS as_of)
```
and it is returned as `(SELECT as_of::text FROM bound) AS as_of`.

**c. The preview's picked set (R48):**
```sql
picked AS (SELECT * FROM matched ORDER BY start_ms ASC, id ASC LIMIT $n)
```

**d. The apply's picked set (R47 + R48 + R49):**
```sql
picked AS (
  SELECT w.id
    FROM bench_window w
    JOIN bench_session s ON s.id = w.session_id
    LEFT JOIN bench_window_silence z ON z.window_id = w.id
    CROSS JOIN bound b
   WHERE w.state = $1
     AND COALESCE(z.decided_at, w.closed_at, w.created_at) <= b.as_of
     ... the four scope predicates and the include-reopened predicate, unchanged ...
   ORDER BY w.start_ms ASC, w.id ASC
   LIMIT $n
)
```

**e. The move and the stamp (R49):**
```sql
moved AS (
  UPDATE bench_window w SET state = 'closed'
   WHERE w.id IN (SELECT id FROM picked) AND w.state = $1
  RETURNING w.id, w.session_id, w.room_day_id
),
stamped AS (
  INSERT INTO bench_window_silence
    (window_id, session_id, room_day_id, reopened_at, reopened_batch, reopened_reason, reopened_detector,
     reopened_as_of, reopened_history)
  SELECT m.id, m.session_id, m.room_day_id, NOW(), $b::text, $r::text, $d::text,
         b.as_of,
         jsonb_build_array(jsonb_build_object('at', NOW(), 'batch', $b::text, 'reason', $r::text,
                                              'detector', $d::text, 'as_of', b.as_of::text))
    FROM moved m CROSS JOIN bound b
  ON CONFLICT (window_id) DO UPDATE SET
    reopened_at       = EXCLUDED.reopened_at,
    reopened_batch    = EXCLUDED.reopened_batch,
    reopened_reason   = EXCLUDED.reopened_reason,
    reopened_detector = EXCLUDED.reopened_detector,
    reopened_as_of    = EXCLUDED.reopened_as_of,
    reopened_history  = bench_window_silence.reopened_history || EXCLUDED.reopened_history
  RETURNING window_id
)
SELECT id FROM moved ORDER BY id
```

**f. 0101's new column:**
```sql
reopened_as_of     TIMESTAMPTZ,
```

**g. 0101's upgrade path — the 25 ADD COLUMNs are mechanical; the four nullability lifts, the backfill and
the three CHECK re-adds are the load-bearing ones:**
```sql
ALTER TABLE bench_window_silence ADD COLUMN IF NOT EXISTS reopened_detector  TEXT;
ALTER TABLE bench_window_silence ADD COLUMN IF NOT EXISTS reopened_history   JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bench_window_silence ADD COLUMN IF NOT EXISTS reopened_as_of     TIMESTAMPTZ;
ALTER TABLE bench_window_silence ALTER COLUMN verdict            DROP NOT NULL;
ALTER TABLE bench_window_silence ALTER COLUMN engine             DROP NOT NULL;
ALTER TABLE bench_window_silence ALTER COLUMN audio_level_source DROP NOT NULL;
ALTER TABLE bench_window_silence ALTER COLUMN vad_params_source  DROP NOT NULL;

UPDATE bench_window_silence
   SET reopened_detector = COALESCE(reopened_detector, 'unrecorded.pre-r31'),
       reopened_history  =
         CASE WHEN jsonb_array_length(COALESCE(reopened_history, '[]'::jsonb)) = 0
              THEN jsonb_build_array(jsonb_build_object(
                     'at', reopened_at, 'batch', reopened_batch, 'reason', reopened_reason,
                     'detector', COALESCE(reopened_detector, 'unrecorded.pre-r31'), 'as_of', NULL::text))
              ELSE reopened_history END
 WHERE reopened_at IS NOT NULL;

ALTER TABLE bench_window_silence DROP CONSTRAINT IF EXISTS bench_window_silence_detector_chk;
ALTER TABLE bench_window_silence ADD CONSTRAINT bench_window_silence_detector_chk
  CHECK ((reopened_at IS NULL) = (reopened_detector IS NULL));
ALTER TABLE bench_window_silence DROP CONSTRAINT IF EXISTS bench_window_silence_row_kind_chk;
ALTER TABLE bench_window_silence ADD CONSTRAINT bench_window_silence_row_kind_chk
  CHECK ((verdict IS NOT NULL AND engine IS NOT NULL AND audio_level_source IS NOT NULL AND vad_params_source IS NOT NULL)
         OR reopened_at IS NOT NULL);
ALTER TABLE bench_window_silence DROP CONSTRAINT IF EXISTS bench_window_silence_history_chk;
ALTER TABLE bench_window_silence ADD CONSTRAINT bench_window_silence_history_chk
  CHECK (jsonb_typeof(reopened_history) = 'array'
         AND (reopened_at IS NULL OR jsonb_array_length(reopened_history) >= 1));
```

## 9. Deviations and flags

1. **`as_of` is REQUIRED on the apply, not optional.** The order said the preview returns an as_of and "the
   caller passes it back"; it did not spell out required. I read it as required, because an optional bound is
   no bound — the call that omits it is exactly the call that wanted the old behaviour, and the whole defect
   returns for free. Refused as `as_of_required` before anything moves. **This is a contract change to a
   published tool.** Flagged for the Orchestrator to confirm or overturn.
2. **A dry run now honours an `as_of` when given one.** Not in the order. Found while testing: the surface
   accepted the argument and silently ignored it, so an operator could not re-read the set at the bound they
   had been handed, and a pin was assertable but not reproducible. One line; caught by mutant W29.
3. **The bound is a clock, not a snapshot — the residual hole, named.** A writer whose transaction began
   before the preview and committed after it can still slip one row under the bound. Far narrower than the
   unbounded apply, but not nothing. It is in the code comment (rule 21) rather than behind a claim that it
   cannot happen, which is the mistake the last round's "by construction" made. An exact fix needs a snapshot
   id rather than a timestamp, which is neither compact nor auditable in the way the order asked for.
4. **`remaining_eligible` is deliberately NOT bounded by the as_of.** It answers "how much is still waiting"
   for the next pass, which is a live question; a bounded answer would hide every window that turned silent
   since. `would` is pinned, `remaining_eligible` is live, and the code says so.
5. **`docs/operator-mcp/TOOL-NOTES.md` was edited** — one paragraph, because it stated the apply's required
   arguments and would otherwise have documented a refusal operators will now hit. Inside the E18 contract
   (`fea3f81` already touches this file). Say so if it should not have moved.
6. **`listSilentWindows` got the same tiebreaker.** The order named the preview and the apply; this is the
   third statement with the identical latent tie, and leaving it would have left the defect half-cured. One
   token; mutant W19 pins it.
7. **`'unrecorded.pre-r31'` is a new literal in the ledger.** It is a named absence, not a vocabulary, and it
   classifies nothing — but it is a string a later reader will see, so it is called out rather than buried.
8. **W8/W9 became equivalents because of this round's own fix**, until the drift test was added (§7). Worth
   the Refuter's attention as a pattern: an ALTER that repairs the CREATE TABLE body makes the body's copy
   non-load-bearing.
9. **The refutation document and this report are untracked in the MAIN worktree, not committed.** The code
   commit is on `vinay/e18-silence-is-evidence` in the `-e18` worktree; a bus document in a different
   worktree cannot go into it. No order names committing them. Left for V.

**What held and still holds, checked:** R38 (a no-evidence window gets its first ledger row and drops out of
the eligible set) — test green, W3 caught. R39 (both passes on the record, in order) — test green, W4/W5
caught. The CHECKs on every branch including the conflict paths — W8/W9/W28 caught. R31.5 (the detector name
constrained in SHAPE only) — W6/W7 caught, no vocabulary added, E13/E15 untouched. R37 (preview 100, moved
100, remaining 150, eligible 250) — test green and now additionally pinned by the preview's own as_of.

## 10. Migrations and manual steps for V

**None to run.** 0101 remains committed and **NOT applied to any database**. It was applied only inside
ephemeral `postgres:16` containers; none is left running (`docker ps -a | grep eta` is empty).

When 0101 is eventually applied, it is now safe against a database in either state — never seen, or holding
an earlier draft — and safe to re-run.

## 11. Subagents

None. Every edit, run and measurement in this round is mine.
