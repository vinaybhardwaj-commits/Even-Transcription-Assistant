# ETA — voice_centroid, the 0113/0115 split. REFUTER RE-CHECK. 23 Sep 2026

`vinay/voice-centroid` **`c652cd2` → `e26c4e2`** (builder lx), one commit: `db/migrations/0113_voice_centroid.sql`, the new `db/migrations/0115_voice_centroid_retirement_provenance.sql`, and `tests/unit/voice-centroid.test.ts`. Re-check of the CAVEAT in `ETA-VOICE-CENTROID-R2-REFUTER-RECHECK-22-SEP-2026.md` — retirement provenance added inside `CREATE TABLE IF NOT EXISTS` would never reach a database that had already applied 0113. Own detached worktree `/tmp/refute-vc3`; nothing pushed; **no migration applied by me** and no database touched. Mini kept out per Fable's order — every run on the Yoga.

## PASS — the caveat is closed, and closed at the level it was raised

The columns move to their own migration. All three environments converge, which was the whole point:

| environment | 0113 | 0115 |
|---|---|---|
| applied the **old** 0113 | skipped (version recorded) | `ADD COLUMN IF NOT EXISTS` **adds both** |
| applied the **interim** 0113 that carried the columns | skipped | both `ADD COLUMN` are no-ops, constraint guard finds it present |
| **fresh** database | creates the base table | adds the columns |

That is the right shape. My caveat was that `CREATE TABLE IF NOT EXISTS` silently skips, so a column added inside it reaches only databases that had never run the file — 0113 would have named two different tables depending on when it ran. Splitting removes the possibility rather than documenting it.

### The backfill is the part I most wanted to check, and it is honest

A database holding a row already retired without provenance is exactly where the naive fix breaks: the CHECK cannot be added, so the migration fails on the database that needs it most. 0115 marks those rows `unknown_pre_0115` / `'retired before 0115; provenance not recorded'` rather than inventing an actor, then adds the CHECK. The `WHERE retired_at IS NOT NULL AND (retired_by IS NULL OR retired_reason IS NULL)` never touches an active row and never overwrites provenance a row already has, and `coalesce` makes a second run a no-op.

### Mutations — 9 of 9 killed, 0 runner errors

Including **V1, the split itself**: putting `retired_by` / `retired_reason` back into 0113's `CREATE TABLE` dies, so the separation is pinned and cannot be quietly undone. So do idempotent `ADD COLUMN`, the backfill's `retired_at IS NOT NULL` guard (without it an active row would be stamped), `coalesce` preserving existing provenance, the `pg_constraint` guard, the CHECK requiring **both** actor and reason, the self-record being present, its version being 115 rather than 114, and 0115 creating no table and granting nothing.

**V7 deserves a note**: recording 0115 as version `114` dies twice over — once in this file's own test and once in `tests/unit/migrations-self-record.test.ts`, which asserts repo-wide that no two files claim the same version and that versions match filenames. That repo-wide guard is what protects against two branches allocating the same number, and it is live.

### Verified, not taken from the commit message

- **The `DO $$ … $$` block is safe.** `splitSql` (`app/api/run-migrations/route.ts:54`) tracks `inDollar`, and **27 migrations already use dollar-quoted blocks**, all of them applied — production is at 112. The path is proven many times over, not newly exercised here.
- **The comment-stripping in the test is load-bearing and correct.** 0113's new comment mentions `retired_by` once, and the test asserts `code` does **not** match `/retired_by|retired_reason|voice_centroid_retirement_chk/`. It passes only because the test strips `--` lines first. Without that, the negative assertion would fail on the very comment that documents the split. Worth saying because it looks redundant and is not.
- **The unqualified `conname` guard follows repo precedent.** `SELECT 1 FROM pg_constraint WHERE conname = '…'` is not relation-qualified, so a same-named constraint on another table would skip the add. This is the dominant convention in this repo (11+ uses against 2 that filter on `conrelid`), and the name is specific, so I am recording it as consistent rather than as a finding. The `conrelid = 'voice_centroid'::regclass` form exists in-repo (`0045`-era, `bench_command`) if anyone wants to tighten it later.

### NOTE — the only executing migration test stops at 0102

0113 and 0115 are pinned by **regex assertions against the SQL text**, which pin wording rather than effect. The repo does have an executing harness — `tests/support/s1-pg`, `pgContainer`, a real `postgres:16` — but the one test that uses it for migrations (`e20-migration-order.test.ts`) covers through 0102 only.

The builder proved 0115 on a Neon branch built to be the awkward case (old 0113 applied, one row retired without provenance, one active; applied twice; CHECK refused a bare retire afterwards). That is the right proof and I have no reason to doubt it — **but it is theirs, not mine, and the branch was deleted, so it is not reproducible and not in CI.** A `pgContainer` test over the three convergence paths above would make the claim permanently checkable, in the pattern `e20` already establishes for exactly this question. Not a blocker; the migration is unapplied everywhere and its shape is right.

## Migration ordering — Fable's question, answered from the repo rather than inferred

Production is at 112, so 0113, 0114 and 0115 all land unapplied, and 0114 belongs to a different branch. Three facts settle it:

1. **The runner applies by individual version, not by a high-water mark.** `discoverMigrations()` sorts ascending by number and the loop skips on `appliedVersions.includes(m.version)` — membership in `schema_migrations`, not position. So a gap is tolerated, and a lower-numbered file that arrives later is still applied. This is not my reading of the code: `tests/unit/e20-migration-order.test.ts` documents it verbatim and proves it against a real `postgres:16`, because **it has already happened in production** — 0097–0102 were applied with 0096 absent, and 0096 then applied out of order on top.
2. **0114 is independent of 0113/0115.** It creates `encounter_hypothesis_run` and `encounter_hypothesis`, its only `REFERENCES` is to its own run table, and it names nothing from voice_centroid.
3. **No two branches claim the same number.** I checked every remote branch: `0113`/`0115` on `vinay/voice-centroid`, `0114` on `vinay/encounter-hypothesis`, nothing else in the 0113–0129 range anywhere.

**So any merge order is safe**, including voice-centroid first leaving production at 113/115 with 114 arriving afterwards. Ordering is not a reason to hold either branch.

## Jev — not run

The SQL half of this diff is two `ALTER TABLE`s, a backfill and a guarded constraint; the TS half is a test-only change to a module whose implementation Jev already scored on r2 and which is unchanged here (`c652cd2` → `e26c4e2` touches no `lib/` file). A call would score a diff it has effectively already seen, and the server's guidance is against repeating one. Said plainly so the standing rule's exception is on the record rather than silent.

## Gate

- **Mine:** 9 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `e26c4e2` afterwards. Mini untouched, per the order — night-drain live, swap at 555 MB.
- **The builder's, quoted as theirs:** unit tests 26/26; the Neon proof summarised above on branch `test/lx-voice-centroid-0115`, since deleted.

**Verdict: PASS.** The caveat is closed structurally — provenance now lives in a migration every environment can receive, whatever it has already applied — the backfill is honest about what it cannot know, and the split itself is mutation-pinned. Nothing here blocks the merge queue, and the ordering question resolves in its favour.
