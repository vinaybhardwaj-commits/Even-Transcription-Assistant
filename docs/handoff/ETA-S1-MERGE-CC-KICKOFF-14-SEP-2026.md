# ETA — S1 MERGE — CC KICKOFF
**14 September 2026 · Session: `scribe` · branch `vinay/s1-auto-drain` at `d5c65fa` · FIX4 PASSED, X1 CLOSED**

**Today is a holiday. No clinic, no rooms recording, nothing inserting into `bench_window`.** That removes
the out-of-hours constraint on the migrations. It does **not** remove the procedure — a free lock is a
reason the guard will not fire, not a reason to drop it.

## 0. Machine, repo, push policy — READ, THIS ROUND CHANGES IT

Mac Mini · `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` · `vinay/s1-auto-drain` at `d5c65fa`.
**This round you DO push the branch.** You still never touch `main` and never amend an existing commit.
Every GitHub action and every migration runs from this session — never from V's terminal.

## 1. C19 — the comment correction, first and alone

`lib/emotion/store.ts:157-158` currently describes the compared tuple as "everything the segment rows can
contradict" and lists `model_key` among it. **That is false today** and the Refuter proved why:
`lib/emotion/client.ts:91` rejects any service response whose `model_key` is not `EMOTION_MODEL_KEY`
(`emotion_unexpected_model`), so no segment row carrying a different key is ever written.

Correct the comment to say, in your own words and accurately:
- `model` and `model_key` are pinned by the guard at `client.ts:91`, so within one deployment they cannot
  differ; comparing them matters **across a deploy that changes those constants**, where it correctly
  rewrites the row.
- `subfolder` has **no such guard** and is the field by which X1 was actually reachable — the service reads
  `EMOTION_WAVLM_SUBFOLDER` as `auto`, so it can resolve differently with no deploy at all.
- Keep the existing accurate half: the exclusions (`calls`, `warmup_json`, `timing_json` as per-run
  telemetry; `scored_at`, `attempts`, `failure_history` as write bookkeeping; `diarize_run_id` as its own
  arm).

**Comment only. No behaviour change. No test change.** Then `npx tsc --noEmit` and `npm test`, quoted, and
commit this kickoff plus the FIX4 Refuter verdict plus the comment change, by exact filename.

## 2. C20 — push and preview

1. Push `vinay/s1-auto-drain`. Report the remote ref and the commit it points at.
2. Report the Vercel preview URL and its build result. `ci.yml` fires only on `main`, so expect no CI run —
   confirm that rather than assume it.
3. **G11, carried from round 3: count the crons on the preview deployment.** The expectation is a
   **seventh** cron (`/api/jobs/run`, `* * * * *`). Report the full list with schedules. If there are not
   seven, stop and report — do not promote.

## 3. C21 — migrations 0091 and 0092

Run from this session, both files, in one `psql` session, the env var named only:
```
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0091_disable_gemini_stt_engine.sql
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0092_bench_window_auto_drain_refusal.sql
```
The Refuter verified on a throwaway postgres:16 that the `SET` from `-c` carries into the `-f` file and
that 0092 fails after 3 s when another session holds a lock on `bench_window`. Both files are idempotent.

**After 0091, verify the engine row:** `gemini` must be `enabled=false`. Quote the row (no secrets).
**After 0092, verify the columns** exist on `bench_window` and quote the DDL lines.

## 4. C22 — promotion

Promote the deployment to production. There is no promote tool in the Vercel MCP, so say exactly what you
did and what the production deployment sha is afterwards. Then confirm `/api/health` serves that sha —
**cache-bust the request**, the health endpoint has served a stale sha before.

## 5. C23 — the flag, and the trap in enabling it today

`ROOM_AUTO_DRAIN_ENABLED` goes on for **one room only**. But today nothing is recording, and the selector
requires `state='closed'`, `grid_aligned`, `room_day_id IS NOT NULL`, and
`closed_at >= NOW() - AUTO_DRAIN_MAX_AGE_HOURS hours` — default **6**.

**So before touching the flag, count the eligible windows.** Run the selector's own WHERE clause as a
read-only `SELECT count(*)`, per room, and report it.

- **If the count is zero**, say so and **stop**. Do not enable the flag. A drain that finds nothing proves
  nothing (testing rule 7), and "it ran and did nothing" is the single most misleading result we could
  record today. The flag then waits for clinic.
- **If the count is non-zero for some room**, report which rooms and how many, and stop there anyway.
  Enabling is V's call once he can see the number.

Do not change `AUTO_DRAIN_MAX_AGE_HOURS` to manufacture eligible windows. If we decide to reach back to
older windows, that is a deliberate ruling and it will be given to you explicitly.

## 6. What NOT to do

Do not touch `main`. Do not amend. Do not enable any flag. Do not change `AUTO_DRAIN_MAX_AGE_HOURS` or any
other tunable. Do not run the drain by hand. Do not start any Mini transcription work — `scribe3` has the
Mini next and contention would corrupt its measurement. Env var **NAMES only, never values** — that rule
bit me personally today, so it is not decoration. Never reproduce the banned id shape.

## 7. Report

`docs/handoff/ETA-S1-MERGE-REPORT-14-SEP-2026.md`: the comment diff · gate output · remote ref and pushed
sha · preview URL and build result · whether CI fired · **the full cron list with schedules** · both
migration outputs and the two verifications · the production sha and the cache-busted `/api/health` sha ·
**the per-room eligible-window counts** · flags. Stop after §5. Do not proceed past it.

## 8. Known facts

- `d5c65fa` is FIX4, PASS, X1 closed: 107 test files, 2590 tests, tsc and build clean, `check:silent` exits
  1 with exactly 9 accepted handlers in untouched `app/[slug]/…` files.
- `main` is unprotected: no required checks, no rulesets, no git hooks. Nothing will stop a bad push but us.
- `ci.yml` cannot go green — its last step is `check:silent`, which exits 1 by design on the 9 accepted
  handlers. Red CI on `main` is expected and is being fixed in its own round (S2-CI). Do not fix it here.
- The nightly E2E workflow runs at 02:00 UTC against production and tests the doctor-facing app, not the
  drain.
