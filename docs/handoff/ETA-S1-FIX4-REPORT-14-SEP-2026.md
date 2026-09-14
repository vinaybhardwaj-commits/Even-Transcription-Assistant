# ETA — S1 FIX4 — REPORT (X1: the C9 comparison widened)
**14 September 2026 · Builder · branch `vinay/s1-auto-drain` · one new commit on `6067ba8` · not pushed**

## 1. Commit

One new commit on `6067ba8e304c6b4e2690e47159603755fb86613a`. `6067ba8` was not amended. Nothing was pushed, and `main` was not touched. This report is inside that commit, so it cannot name the commit's SHA. The SHA is printed in the terminal, and `git log -1 --format=%H -- docs/handoff/ETA-S1-FIX4-REPORT-14-SEP-2026.md` returns it.

Pre-flight passed:
- `git rev-parse --abbrev-ref HEAD` returned `vinay/s1-auto-drain`.
- `git rev-parse HEAD` returned `6067ba8…`.
- No tracked changes.

**Staged before the gate:** all five files this commit carries, including a draft of this report containing no id-shaped text. `git diff --name-only` was empty before and after the gate. After the gate only this report's text changed; it was re-staged, and the repo guards were re-run over the final staged set before the commit (the result is printed in the terminal).

## 2. Gate — on the staged tree, green on the first run

Each line is quoted from the run.
- `npx tsc --noEmit` — no output; `tsc exit 0`
- `npm test` — ` Test Files  107 passed (107)` · `      Tests  2590 passed (2590)` · `npm test exit 0`. Nothing was skipped.
  - ` ✓ tests/unit/c2-e2e-runner.test.ts (48 tests)` — **unedited**
  - ` ✓ tests/unit/s1-emotion-zero-scored.test.ts (21 tests)`
  - ` ✓ tests/unit/s1-auto-drain.test.ts (48 tests)`
  - ` ✓ tests/unit/s1-fix2-migrations.test.ts (8 tests)`
  - ` ✓ tests/unit/s1-guard-staged.test.ts (4 tests)`
  - ` ✓ tests/unit/no-real-clinician-ids.test.ts (3 tests)`
  - ` ✓ tests/unit/no-identity-literals.test.ts (2 tests)`
- `npm run build` — ` ✓ Compiled successfully in 3.3s` · `build exit 0`
- `npm run check:silent` — `Found 9 silent-failure handler(s)` · `check:silent exit 1`. **Nine.** All nine are in `app/[slug]/api/encounters/[id]/finalize-text/route.ts`, `…/finalize-upload/route.ts`, `…/process/route.ts` (×5) and `app/[slug]/note/NoteComposerClient.tsx` (×2). No new handler, and none of those files is in this commit.
- Swift — out of scope.

**Test 3 — IDEMPOTENT under the widened tuple, proven.** `npx vitest run tests/unit/c2-e2e-runner.test.ts --reporter=verbose` (the whole file) → `✓ … C3 — emotion_window … > IDEMPOTENT: the same job again for the same diarize attempt duplicates no row and does not rewrite the window` · `Tests  48 passed (48)`. It passed again in the full gate. `git diff --cached --name-only 6067ba8 -- tests/unit/c2-e2e-runner.test.ts` → 0 lines. I did not run it filtered alone; the known order dependence (Refuter O2) predates this work.

**Order independence kept.** `ETA_S1_REVERSE_ORDER=1` on the emotion file → `Tests  21 passed (21)`, the same as normal order.

## 3. `git diff --stat 6067ba8..HEAD`

Taken as `git diff --cached --stat 6067ba8`, excluding this report, which is the fifth file:
```
 .../ETA-S1-FIX3b-REFUTER-VERDICT-14-SEP-2026.md    | 156 +++++++++++++++++++++
 docs/handoff/ETA-S1-FIX4-CC-KICKOFF-14-SEP-2026.md | 107 ++++++++++++++
 lib/emotion/store.ts                               |  29 +++-
 tests/unit/s1-emotion-zero-scored.test.ts          | 133 ++++++++++++++++--
 4 files changed, 412 insertions(+), 13 deletions(-)
```
- `lib/emotion/store.ts` — both conflict `WHERE`s, plus one doc-comment line
- `tests/unit/s1-emotion-zero-scored.test.ts` — seven C16 cases and their helpers
- `docs/handoff/ETA-S1-FIX4-CC-KICKOFF-14-SEP-2026.md`
- `docs/handoff/ETA-S1-FIX3b-REFUTER-VERDICT-14-SEP-2026.md`
- this report

**Nothing on the untouched list moved.** `git diff --cached --name-only 6067ba8` printed 0 lines over:
- `tests/unit/c2-e2e-runner.test.ts` · `tests/support/pg-harness.ts` · `tests/support/repo-files.ts` · `tests/support/s1-pg.ts`
- `tests/unit/no-real-clinician-ids.test.ts` · `docs/handoff/scratch`
- `lib/stt/auto-drain.ts` · `lib/jobs/kinds/emotion-window.ts` · `lib/stt/room-drain.ts` · `lib/bench-window.ts` · `lib/stt/fanout.ts`
- `lib/emotion/enqueue.ts` · `lib/emotion/client.ts` · `lib/mcp` · `lib/stt/adapters`
- `lib/jobs/runner.ts` · `lib/jobs/store.ts` · `lib/jobs/submit.ts`
- `db/migrations` · `vercel.json` · `apps` · `package.json`

## 4. The changed SQL, verbatim

Both conflict `WHERE`s in `lib/emotion/store.ts`. The two standalone arms are unchanged; the compared tuple gains `model, model_key, subfolder, cap_s, room_day_id`.

**`recordEmotionWindow`:**
```sql
    WHERE room_emotion_window.state = 'failed'
       OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
       -- COMPARED, S1 FIX4 C16: everything the segment rows can contradict, plus the facts identifying the run
       -- that produced them - state, error, the four segment counts, model, model_key, subfolder, cap_s, room_day_id.
       -- NOT COMPARED, each on purpose:
       --   calls, warmup_json, timing_json - per-run telemetry with no segment counterpart; comparing them
       --     would rewrite on every re-run and undo C9
       --   scored_at, attempts, failure_history - write bookkeeping, derived from this write itself
       --   diarize_run_id - already its own arm above
       -- IS DISTINCT FROM on the row constructor counts NULL against a value as a difference and NULL against
       -- NULL as equal, so a nullable cap_s and the all-NULL counts of a failure with no rows compare correctly.
       OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
           room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed,
           room_emotion_window.model, room_emotion_window.model_key, room_emotion_window.subfolder,
           room_emotion_window.cap_s, room_emotion_window.room_day_id)
          IS DISTINCT FROM
          (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
           EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed,
           EXCLUDED.model, EXCLUDED.model_key, EXCLUDED.subfolder,
           EXCLUDED.cap_s, EXCLUDED.room_day_id)
```

**`finishEmotionWindow`:**
```sql
      WHERE room_emotion_window.state = 'failed'
         OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
         -- The same comparison as recordEmotionWindow, S1 FIX4 C16 - see the comment there for what is out and why.
         OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
             room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed,
             room_emotion_window.model, room_emotion_window.model_key, room_emotion_window.subfolder,
             room_emotion_window.cap_s, room_emotion_window.room_day_id)
            IS DISTINCT FROM
            (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
             EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed,
             EXCLUDED.model, EXCLUDED.model_key, EXCLUDED.subfolder,
             EXCLUDED.cap_s, EXCLUDED.room_day_id)
      RETURNING state
```

The SQL comments contain no apostrophes, no parentheses and no `select`. Both test harnesses scan statement text for those, and `pg-harness.ts` does not skip `--` comments, so any of them inside the `WITH` statement could mis-split it.

All other text of both statements is as committed at `6067ba8` (quoted in the FIX3b report §7.2 and §7.3). **INFERRED, not run against the live database.** It ran through bound parameters on postgres:16 (`s1-pg.ts`) and through `pg-harness.ts` (`c2-e2e-runner`).

## 5. Tests

All seven cases are in the order-independent case list of `tests/unit/s1-emotion-zero-scored.test.ts`, each seeding its own window.

**Test 1 — X1 as the Refuter reproduced it.** Through the real kind: a settled `ok` window, then a re-run on the same diarize run with identical counts, with the service now reporting model `m2` and subfolder `fp16`.
- `window_row: "written"`, and `scored_at` moved.
- The window row names `m2` / `fp16`.
- Its segment rows carry exactly `{ model: "m2", model_key: "wavlm", subfolder: "fp16", cap_s: 30, room_day_id: "rd_1" }`.

**Test 2 — the control that keeps C9 alive.** The existing case *"C9 — a re-run REPRODUCING the same result writes nothing: scored_at and attempts untouched"* is unchanged and passes under the widened tuple. Every run now sets the service's model, subfolder and cap explicitly, so "identical" really is identical.

**Test 3 — IDEMPOTENT green, file untouched.** §2.

**Test 4 — `cap_s` NULL↔value, with its control.** Store level, because no path through the kind can write a NULL cap on a non-failed row.
- Five successive `recordEmotionWindow` calls on one `no_segments` row, identical except `cap_s`:
  - NULL, then NULL again: **not written** (`scored_at` equal);
  - then 30: **written**;
  - then 30 again: **not written**;
  - then NULL: **written**.
- This shows `IS DISTINCT FROM` on the eleven-field row constructor still treats NULL against a value as a difference in both directions, and NULL against NULL as equal.
- A second NULL case, through the real kind: `room_day_id` NULL → a backfilled value → rewritten.

**One-field cases, so each mutation can be caught on its own:**
- model alone → rewritten
- subfolder alone → rewritten
- `cap_s` alone (30 → 20, the same two segments planned) → rewritten
- `room_day_id` NULL → value → rewritten
- `model_key` alone → rewritten, with an identical control that is **not** written. This case is store level; see F1 for why.

## 6. Mutation check — one per added field: 5 of 5

Each field was removed from both sides of the tuple in both upserts. Every mutation applied exactly **4** edits, verified before the run. The emotion file was rerun, then `store.ts` was restored (`cmp` equal, `RESTORED`), and `git diff --name-only` was empty afterwards.

| field removed | tests failed |
|---|---|
| `model` | **1** (model alone) |
| `model_key` | **1** (model_key alone) |
| `subfolder` | **1** (subfolder alone) |
| `cap_s` | **2** (cap alone; NULL↔value) |
| `room_day_id` | **1** (room_day_id NULL → value) |

The X1 case changes model and subfolder together, so it survives the removal of either field alone. That is why each field has its own case.

## 7. C17 — report only

**Does `room_span_emotion` carry these per row?** From `db/migrations/0089_room_emotion.sql` (no later migration alters either emotion table):

| column | on `room_span_emotion` |
|---|---|
| `model` | **yes** — `model text` |
| `model_key` | **yes** — `model_key text` |
| `subfolder` | **yes** — `subfolder text` |
| `cap_s` | **yes** — `cap_s double precision` |
| `room_day_id` | **yes** — `room_day_id text` |

**So `cap_s` is inside G2's scope:** a segment row records the cap it was planned under and can contradict the window row. The segment table also carries `device`, which the window table does not have, so it cannot be compared.

**Is `cap_s` stable across runs?** Yes, absent a configuration change.
- The emotion service (`~/eta-emotion/app.py:53`, read-only) sets `MAX_DURATION_S = float(os.environ.get("EMOTION_MAX_DURATION_S", "120"))` once, at module load. It is the only assignment in the file.
- `/health` and every segments response report that same value (`:681`, `:1063`).
- The launchd plist (`~/Library/LaunchAgents/uk.llmvinayminihome.emotion.plist`) sets `EMOTION_MAX_DURATION_S` to `60`.
- So the cap changes only when that setting changes and the service restarts. It cannot differ between two calls to one running process.
- The kind already fails a window whose scoring call reports a different cap from `/health` (`emotion_cap_changed`).
- If the variable were removed, the service's default of 120 is outside the client's accepted range of [10, 60], so the window would fail by name rather than rewrite.
- **No jitter, and no reason to rule again.**

## 8. C18 — report only

**Question:** is `npm test` run automatically on a push, a PR or a Vercel build? **Answer: not on this branch's pushes, not on a Vercel build, and in practice not for three weeks. A second net exists on paper and does not currently catch anything.**

**GitHub Actions** (`.github/workflows/`):
- `ci.yml` triggers on `push` to `main` and `pull_request` to `main` only. **A push to `vinay/s1-auto-drain` does not trigger it**; a PR from it into `main` would.
- Its steps: `npm install` → `npm run typecheck` → `npm i -D vitest@^2` + `npx vitest run` (not `npm test`: `typecheck:tests` does not run, but every unit test does) → `npm run check:silent`.
- In a fresh checkout every committed file is tracked, so `no-real-clinician-ids` would scan any bus document that reached the PR. That is the second net.
- **It does not work as a net today:**
  - `check:silent` exits 1 on the 9 accepted findings, so the job concludes `failure` on every run. The last run (id 32812964734, 2026-08-25, push to `main`) shows `Unit tests … success`, then `Silent-failure gate … failure`.
  - Of the last 200 CI runs, 29 succeeded; the newest run is **2026-08-25**. There are 0 commits on `origin/main` after that date, so CI has not run since.
  - A guard failure would show only as a different failing step inside a job that is already red.
- `e2e.yml` is a nightly Playwright run against the production URL (schedule, plus manual dispatch). It does not run unit tests. Its last three runs (11, 12, 13 Sep) are `failure`.

**Branch protection (read via `gh api`):** `main` → `"protected": false`, required status checks `[]` (`enforcement_level: off`), repository rulesets **0**. Nothing requires CI to pass before a merge.

**Vercel:**
- `vercel.json` has no `buildCommand`, and `package.json` `"build"` is `next build`. The repo's own configuration runs no tests on a Vercel build.
- **UNVERIFIED:** whether the Vercel project settings override the build command. That lives in the dashboard, not in the repo, and I have no deploy-platform access.

**Local hooks:** `.git/hooks` has no non-sample hook, and there is no `.husky`. Nothing runs at commit time.

**Net:** the only thing that runs the id guard is a person running `npm test`, locally, after staging. As built, CI would scan committed bus documents on a PR to `main`, but its job is always red and nothing requires it.

## 9. Flags

**F1 — through the kind, `model_key` cannot differ, so the window row can still disagree with its segment rows on it.**
- `finish()` (`lib/jobs/kinds/emotion-window.ts`, untouched this round) writes `model_key: EMOTION_MODEL_KEY`, the client's constant.
- The segment rows write `res.model_key ?? EMOTION_MODEL_KEY`, the service-reported value.
- If the service ever reported a different `model_key`, the segment rows would carry it and the window row would keep the constant. **No comparison can fix that, because the window write never carries the new value.**
- The C16 comparison of `model_key` is proven at the store level only.
- The fix, if wanted: pass the service-reported key through progress to `finish()`. That is a change to `emotion-window.ts`, outside this round.
- Today the service reports `wavlm`, which equals the constant.

**F2 — `device` is per segment row but absent from the window table,** so G2 cannot cover it without a migration. Recorded, not a request.

**F3 — C18: CI is red on every run because of the 9 accepted findings,** and has not run since 25 Aug. Anything that relies on CI as a net is relying on a job whose failure is the normal state.

**Known debt carried unchanged:** `pg-harness.ts`'s `WITH … INSERT … SELECT` split; `c2-e2e-runner` IDEMPOTENT's order dependence when filtered alone; the seventh Vercel cron watch (`vercel.json` untouched).

## 10. Manual steps for V

None this round. No migration. The 0091/0092 step from round 4 §4 stands unchanged.

## 11. Subagents

None. The gate, the five mutations, the reversed-order run, and the read-only CI, branch-protection and emotion-service checks were done in this session.
