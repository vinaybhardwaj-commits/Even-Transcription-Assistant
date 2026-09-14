# ETA — S1 FIX1 — CC KICKOFF
**14 September 2026 · Session: `scribe` · Same branch, NEW COMMIT. Never amend `d852127`.**

## 0. Machine, repo, branch, push policy

Mac Mini · `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` · branch **`vinay/s1-auto-drain`**,
already checked out at `d852127`. **Commit on the branch. DO NOT push. DO NOT touch `main`.**
Rulings are in `docs/handoff/ETA-S1-D1-VERDICT-AND-RULINGS-14-SEP-2026.md` — read it first. Every
decision below is SETTLED; do not re-open one.

## 1. Pre-flight

```
pwd
git rev-parse --abbrev-ref HEAD     # expect vinay/s1-auto-drain
git rev-parse HEAD                  # expect d852127
git status --porcelain | grep -v '^??'   # expect EMPTY
```
Stop and report on any mismatch.

## 2. The four changes

**C1 — F1, the retry storm.** In `lib/stt/auto-drain.ts`, before calling `drainRoomWindow` for a
window, ensure its legacy queue row exists by calling the same helper `lib/bench-window.ts` uses on
window close — `enqueueSubject("bench_window", <window_id>, "asr")` from `lib/stt/fanout.ts`, which is
ON CONFLICT DO NOTHING and therefore safe to call for a window that already has one. Then drain.
Do **not** change the selector, do **not** change `recordFailure`, do **not** touch
`lib/stt/room-drain.ts`.

**C2 — F3, the actor.** Give `enqueueAutoDrain` an actor parameter (`{ actor, via }`) defaulting to
`SYSTEM_ACTOR` / `"cron"`. The GET handler keeps the default. **The POST handler passes the resolved
admin id with `via: "admin_route"`.** `app/api/admin/diarize-windows/route.ts` already resolves an
actor for POST — copy that shape. When POST is authorised by `MIGRATION_SECRET` rather than an admin
cookie, use whatever actor string that route uses for the same case; do not invent a new one.

**C3 — F4, the one status change.** The route returns **500** when the drain step is `join_failed`
with detail `join_service_not_configured`. Every other step keeps the status it returns today.

**C4 — the `gemini` row.** New migration `db/migrations/0091_disable_gemini_stt_engine.sql`: set
`enabled = false` on the `stt_engine` row whose id is `gemini`. Header comment must state: the row is
disabled because `GEMINI_STT` gates the engine off, so an enabled row made `scribe_health` count a
permanently failing engine (`lib/mcp/tools/health.ts:116`, `lib/stt/adapters/gemini.ts:345`); re-enable
by setting `enabled = true` **and** setting the `GEMINI_STT` env var, never one alone. Idempotent —
a re-run must not error.

## 3. Also commit the bus documents (F8)

`git add` and commit, by exact filename, these files under `docs/handoff/` (all currently untracked):
`ETA-S1-AUTO-DRAIN-CC-KICKOFF-14-SEP-2026.md` · `ETA-S1-AUTO-DRAIN-REPORT-14-SEP-2026.md` ·
`ETA-S1-D1-VERDICT-AND-RULINGS-14-SEP-2026.md` · `ETA-S1-FIX1-CC-KICKOFF-14-SEP-2026.md` ·
`ETA-D1-HEALTH-PROBES-DEBUG-BRIEF-14-SEP-2026.md` · `ETA-D1-HEALTH-PROBES-ROOTCAUSE-14-SEP-2026.md` ·
and your own FIX1 report when you write it.
**Do not `git add .` and do not commit any other untracked file** — the 15 pre-existing untracked bus
files from earlier slices are not yours to commit.

## 4. File contract

**Edit:** `lib/stt/auto-drain.ts` · `app/api/admin/drain-windows/route.ts` · the two S1 test files.
**Create:** `db/migrations/0091_disable_gemini_stt_engine.sql`.
**Untouched:** `lib/stt/room-drain.ts` · `lib/bench-window.ts` · `lib/stt/fanout.ts` ·
`lib/mcp/tools/health.ts` · `lib/stt/adapters/gemini.ts` · `lib/jobs/**` · `lib/stt/registry.ts` ·
`vercel.json` · `apps/**` · `package.json`.

## 5. Tests

- C1: a window with no legacy row is drained **once** and its failure is recorded with a non-zero
  attempt count — paired with a control proving a window that already has a row is not double-inserted.
- C2: GET records `SYSTEM_ACTOR`/`cron`; POST records the admin id/`admin_route`. Both asserted, so the
  refusal is not universal (rule 7).
- C3: `join_service_not_configured` ⇒ 500, paired with another step ⇒ 200.
- C4: the migration is idempotent.
- Re-run the removal check you invented on S1 — remove each new rule in turn and confirm a test fails.
  Report the count.

## 6. Gate and report

`npx tsc --noEmit` and the full suite, both green, output quoted. `swift` is out of scope.
Report to `docs/handoff/ETA-S1-FIX1-REPORT-14-SEP-2026.md`: new sha · gate output · `git diff --stat`
against `d852127` · **every inferred SQL string verbatim, including the migration** · the removal-check
count · flags. Env var NAMES only, never values.
