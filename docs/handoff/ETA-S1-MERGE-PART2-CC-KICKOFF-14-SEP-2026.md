# ETA — S1 MERGE, PART 2 — CC KICKOFF (fresh session, DB env present)
**14 September 2026 · Session: `scribe`, restarted · branch `vinay/s1-auto-drain` at `fe021a3`**

You are a **new session**. The first half of this merge is already done by your predecessor and committed.
Read `docs/handoff/ETA-S1-MERGE-REPORT-14-SEP-2026.md` for what it did, then do only what is below.

## 0. What is already done — do not redo any of it

- **C19** — the `lib/emotion/store.ts` comment correction. Committed. Gate was green: `tsc exit 0`,
  107/107 files, 2590/2590 tests.
- **C20** — pushed. `refs/heads/vinay/s1-auto-drain` → **`fe021a3`**. `main` untouched. Preview built in
  38 s and is READY. **CI did not fire** — zero Actions runs for the branch, as expected (`ci.yml` triggers
  only on `main`).
- **Crons, as far as a preview can answer:** `vercel.json` at `fe021a3` lists **seven**, production has
  **six**, and the entry S1 adds is `/api/admin/drain-windows` (`*/5`). Your predecessor correctly refused
  to claim a platform readout: **Vercel activates crons only on production deployments, so a preview has no
  live cron list.** That was an error in my kickoff, not in the build.

## 1. What changed in your environment, and its one boundary

`APP_DATABASE_URL` **is now set in this shell's environment** and points at production. It was placed there
by V with `read -rs`, so it never appeared as a command argument and is not in shell history.

- **Use it only as `"$APP_DATABASE_URL"`.** Never echo it, never print it, never interpolate it into report
  text, a log, a commit message or an error quote. If a command would print it, redirect or mask first.
- The repo `CLAUDE.md` line *"No live database in this sandbox"* remains the default. **This round is a
  deliberate, narrow exception**, ruled by V and scoped to §2 and §3 of this document. It does not extend
  to any other query, table, or round.
- **You still do not deploy.** Promotion is V's, by hand, in the Vercel dashboard — there is no CLI, no
  token and no promote tool. Do not attempt it.

## 2. C21 — migrations 0091 and 0092

Both idempotent. Run them in one `psql` session each, env var named only:
```
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0091_disable_gemini_stt_engine.sql
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0092_bench_window_auto_drain_refusal.sql
```
The Refuter verified on a throwaway postgres:16 that the `SET` from `-c` carries into the `-f` file, and
that 0092 fails after 3 s when another session holds a lock on `bench_window`. **Nothing is recording
today — it is a holiday — so the lock should be free.** A free lock is why the guard will not fire, not a
reason to drop it.

**Before you run anything, confirm you are pointed where you think you are**, without printing the URL:
```
psql "$APP_DATABASE_URL" -At -c "select current_database(), current_user, inet_server_addr() is not null"
```
Report that line. If it does not look like production, **stop and say so**.

**Verify after each:**
- After 0091 — the `gemini` engine row is `enabled = false`. Quote the row.
- After 0092 — the new columns exist on `bench_window`. Quote the DDL lines.

If either migration errors, **stop**. Do not retry, do not repair, do not run the next one.

## 3. C23 — the eligible-window counts, read-only

Run the auto-drain selector's own `WHERE` as a **`SELECT count(*)`**, grouped by room, and report two
numbers per room so a zero is never ambiguous:

1. windows `closed`, `grid_aligned`, `room_day_id IS NOT NULL`, closed within
   `AUTO_DRAIN_MAX_AGE_HOURS` (default **6**) — **ignoring** the Transcript filter;
2. the same, **with** `room.transcript_enabled = TRUE`.

Also report `transcript_enabled` per room as its own column. A zero in (2) with a non-zero in (1) means
Transcript is off, which is a completely different fact from "no recent windows", and today — a holiday,
nothing recording — (1) may well be zero for every room.

**Read-only. Do not enable any flag. Do not change `AUTO_DRAIN_MAX_AGE_HOURS` or any other tunable to
manufacture eligible rows. Do not run the drain.** Stop after reporting.

## 4. Not yours this round

**C22, promotion** — V's, by hand. **G11, the seventh cron** — cannot close until after promotion, by
observing `/api/jobs/run` actually fire in production; it is no longer your item. The health-sha check
belongs with promotion and moves with it.

## 5. Report

Append to `docs/handoff/ETA-S1-MERGE-REPORT-14-SEP-2026.md` under a **PART 2** heading, or write
`ETA-S1-MERGE-PART2-REPORT-14-SEP-2026.md` — your choice, say which. Include: the identity line from §2 ·
both migration outputs · both verifications · the per-room table from §3 · flags.

Commit this kickoff and your report by exact filename. **Do not `git add .`. Do not push** — the branch is
already at `fe021a3` on the remote and V promotes from there; a second push mid-promotion is the one thing
that could confuse it. Env var **NAMES only, never values**. Never reproduce the banned id shape.
