# ETA — voice_centroid round 2. REFUTER RE-CHECK. 22 Sep 2026

`vinay/voice-centroid` **`4cf422d` → `c652cd2`** (builder lx), one commit: `db/migrations/0113_voice_centroid.sql`, `lib/voice-centroid.ts`, `tests/unit/voice-centroid.test.ts`. Re-check of the two findings in `ETA-VOICE-CENTROID-REFUTER-22-SEP-2026.md`. Own detached worktree `/tmp/refute-vc2`; builder's worktree never written to, nothing pushed, **no migration applied**. Production reads were read-only.

## PASS — both findings closed; one deployment caveat

**Gate, on the Yoga runner:** `Test Files 163 passed (163)`, `Tests 3665 passed | 1 skipped (3666)`, **0 failed**; `build ✓ Compiled successfully in 14.6s`; 489 s wall.

### FINDING 1 — a revoked centroid could reach the matcher — CLOSED

There are now **two** guards where there was one. The readers still ask for `retired_at IS NULL`, and `isActive()` drops any row that comes back with `retired_at` set — applied in **both** `readActiveCentroid` (`return isActive(c) ? c : null`) and `listActiveCentroids` (`if (isActive(c) && !seen.has(...))`). My original probe showed the JS layer returning a revoked centroid unchanged; that path is now closed independently of the SQL, which was the point: a regressed clause can no longer hand a revoked print to a matcher.

### FINDING 2 — revocation recorded only a timestamp — CLOSED

`retired_by` and `retired_reason` are columns, and `voice_centroid_retirement_chk` makes a retired row without both **impossible at the database**, not merely discouraged. Both retire paths set them: superseding records the writer's actor and `superseded_by:<new id>` in the same single statement that retires and inserts; revocation requires a validated actor (`ACTOR_RE`) and a one-line reason (`REASON_RE`, 1–200 chars, no newlines — "provenance, not a note"). `retireCentroid` keeps `AND retired_at IS NULL`, so an earlier retirement's provenance is never overwritten.

**Also fixed, though I had only noted it:** `readActiveCentroid` and `listActiveCentroids` now validate `embeddingModel` against `MODEL_RE`, so all three entry points validate alike.

### Re-verified

- **Migration 113 is still free and safe to edit in place.** Production: `voice_centroid` does **not exist**, `max(version) = 112`, no `schema_migrations` row for 113. Across every remote branch head, only `origin/vinay/voice-centroid` carries a `0113_*` file.
- **The changed signatures break nothing.** `retireCentroid(id)` → `retireCentroid(id, { actor, reason })` with a `RetireResult` union instead of a boolean, and `CentroidInput.actor` is now required. There are **no callers** of any of the four exported functions outside the module and its tests.

### CAVEAT — an environment that already applied the OLD 0113 will not get the new columns

The table is created with `CREATE TABLE IF NOT EXISTS` and the change adds no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. Anywhere the first version of 0113 was already applied — a Neon test branch, for instance — re-running the migration **skips silently**, leaving a table with no `retired_by`, no `retired_reason` and no retirement CHECK, against which every write path in this module would fail. **Production is unaffected** (the table does not exist there), so this is not a blocker. Cheap belt-and-braces: two idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements plus the constraint guarded by `DROP CONSTRAINT IF EXISTS`, which also makes re-application safe for good.

### Mutations — NOT RUN, blocked by the runner

Per the ruling I moved the harness to `yoga-test.sh --mutate`. It is broken: the orchestrator scps the patch to a path **relative to the remote home** and passes that relative string on, while the remote script `cd`s into the session directory before testing for it — `RESULT patch_missing`, `rc=2` (`yoga-test.sh:122-124` vs `yoga-ci-remote.sh:172,193`). Reported to Fable rather than falling back to the Mini. My harness classified both attempts as **ERROR, not "killed"** — a harness that read a non-zero exit as a kill would have recorded two false kills off a runner fault. Mutations for this branch and for `segments-route` run as soon as the path is made absolute.

## Jev (V's standing rule) — after my read and rerun; neutral context

Task, diff and neutral context; none of my findings. **Scores 7.4–8.2, up from 5.2–6.7 on round 1** of this same branch, and the `observability` dimension that flagged the revocation gap in round 1 (5.6) no longer registers at all. That movement is the clearest corroboration of the two fixes.

- **compatibility 7.6** ("appears to break an existing contract") → **CONFIRMED but not impacting**: the signature and return-type changes are real; there are no callers.
- **correctness 7.5** ("an important edge case appears insufficiently handled") → **CONFIRMED in substance**: the `IF NOT EXISTS` caveat above.
- **changeability 7.8 / duplication 7.6** ("the same rule in multiple places") → **CONFIRMED but deliberate**: the active-row rule now lives in the SQL clause and in `isActive`, which is exactly the defence in depth Finding 1 asked for. Worth saying in the file that the duplication is intentional.
- **reliability 7.7** ("a race or concurrency assumption") → **REJECTED**, as in round 1: the retire-and-insert is still one statement, and the loser of a race still rolls back on the generation UNIQUE.

**Verdict: PASS.** Both findings are closed at the level they were raised — one in code with a second independent guard, one in the schema so the database itself refuses a retirement without provenance. The only open item is the migration-idempotency caveat, which matters to test environments rather than production.
