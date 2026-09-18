# ETA — S1 MERGE — REPORT (STOPPED AT C21: NO DATABASE ACCESS FROM THIS SESSION)
**14 September 2026 · Builder · `vinay/s1-auto-drain` pushed at `fe021a3` · `main` untouched**

## Summary

| Step | Result |
|---|---|
| **C19** (comment correction) | Done. Committed `fe021a3`; gate green. |
| **C20** (push and preview) | Done. Branch pushed, preview READY, CI did not fire, `vercel.json` has 7 crons. The deployment-side cron list is UNVERIFIED (§3). |
| **C21** (migrations) | **Not run.** `APP_DATABASE_URL` is not set in this session's shell. |
| **C22** (promotion) | **Not run.** It follows C21, and this session has no Vercel CLI, no `VERCEL_TOKEN`, and no promote tool. |
| **C23** (eligible-window counts) | **Not run.** It needs the same database access as C21. |

No migration, promotion, flag change, tunable change, manual drain or Mini work was started. This report is untracked.

## 1. C19 — the comment correction

`git show fe021a3 -- lib/emotion/store.ts`: comment lines only, +10 −2, in the conflict `WHERE` of `recordEmotionWindow`. No SQL token changed and no test changed.
```diff
-       -- COMPARED, S1 FIX4 C16: everything the segment rows can contradict, plus the facts identifying the run
-       -- that produced them - state, error, the four segment counts, model, model_key, subfolder, cap_s, room_day_id.
+       -- COMPARED, S1 FIX4 C16: state, error, the four segment counts, model, model_key, subfolder, cap_s, room_day_id.
+       -- What each identifying field protects against, corrected in S1 MERGE C19:
+       --   model, model_key - the emotion client refuses any service answer whose model or model_key is not its
+       --     own constant, lib/emotion/client.ts:91 emotion_unexpected_model, so within one deployment no segment
+       --     row can carry a different value and these never decide a write. They matter across a deploy that
+       --     changes those constants: the stored row has the old value, the new write the new one, and the row is
+       --     correctly rewritten.
+       --   subfolder - no such guard. The service resolves EMOTION_WAVLM_SUBFOLDER from auto, so it can change with
+       --     no deploy at all; this is the field by which X1 was actually reachable.
+       --   cap_s, room_day_id - carried by every segment row, so a segment row can contradict them.
        -- NOT COMPARED, each on purpose:
```
- The exclusions block that follows (`calls`, `warmup_json`, `timing_json`; `scored_at`, `attempts`, `failure_history`; `diarize_run_id`) is unchanged.
- The added lines contain no apostrophe, parenthesis or `select`: 0 matches.
- Premises checked: `client.ts:91` refuses when `b.model !== EMOTION_MODEL_ID || b.model_key !== EMOTION_MODEL_KEY`, and `~/eta-emotion/app.py:36` has `WAVLM_SUBFOLDER_PREF = os.environ.get("EMOTION_WAVLM_SUBFOLDER", "auto")` (read-only).

**Gate** — staged first (`git diff --name-only` empty), then run:
- `npx tsc --noEmit` — `tsc exit 0`
- `npm test` — ` Test Files  107 passed (107)` · `      Tests  2590 passed (2590)` · `npm test exit 0`, including ` ✓ tests/unit/no-real-clinician-ids.test.ts (3 tests)`, ` ✓ tests/unit/s1-emotion-zero-scored.test.ts (21 tests)` and ` ✓ tests/unit/c2-e2e-runner.test.ts (48 tests)`

**Commit** `fe021a30f6ae70d4a6ffcf4efaf53332ef322527`: `3 files changed, 187 insertions(+), 2 deletions(-)`. The three files were `lib/emotion/store.ts`, `docs/handoff/ETA-S1-MERGE-CC-KICKOFF-14-SEP-2026.md` and `docs/handoff/ETA-S1-FIX4-REFUTER-VERDICT-14-SEP-2026.md`, staged by exact filename. The verdict has 0 id-shape matches.

## 2. C20 — push and preview

**Push:** `git push -u origin vinay/s1-auto-drain` → `* [new branch]      vinay/s1-auto-drain -> vinay/s1-auto-drain`.
- Remote ref: `git ls-remote origin refs/heads/vinay/s1-auto-drain` → `fe021a30f6ae70d4a6ffcf4efaf53332ef322527	refs/heads/vinay/s1-auto-drain`, equal to local `HEAD`.
- Nothing else was pushed. `main` was not touched.

**Preview (Vercel MCP, read-only):**
- deployment `dpl_633zsUtSU5ewd6fEcZBpynWwu9o6`
- URL `https://even-transcription-assistant-2xhvy84o7.vercel.app`
- branch alias `even-transcription-as-git-d2772d-vinaybhardwaj-commits-projects.vercel.app`
- `githubCommitSha: fe021a30f6ae70d4a6ffcf4efaf53332ef322527`, `githubCommitRef: vinay/s1-auto-drain`, region `bom1`, `target: null` (preview)

**Build result: READY** (`readyState: READY`, `aliasError: null`, about 49 s from `buildingAt` to `ready`). Quoted from the build log:
- `Running "npm run build"`
- `> next build`
- ` ✓ Compiled successfully in 9.6s`
- ` ✓ Generating static pages (21/21)`
- `Build Completed in /vercel/output [38s]`
- `Deploying outputs...`

**CI did not fire, confirmed rather than assumed:** `gh api …/actions/runs?branch=vinay/s1-auto-drain` → `{"runs":[],"total_count":0}`. The newest run in the whole repository is still `E2E`, `schedule`, `main`, `2026-09-13T07:23:55Z`.

## 3. C20.3 / G11 — the cron list

**From `vercel.json` at `fe021a3`, the file this preview was built from: seven crons.**
1. `/api/admin/reap-stuck` — `0 * * * *`
2. `/api/admin/resume-processing` — `*/3 * * * *`
3. `/api/admin/measure-windows` — `30 20 * * *`
4. `/api/admin/diarize-windows` — `*/5 * * * *`
5. `/api/admin/emotion-windows` — `*/5 * * * *`
6. `/api/admin/drain-windows` — `*/5 * * * *`  ← **the one S1 adds**
7. `/api/jobs/run` — `* * * * *`

- **About the premise:** `/api/jobs/run` is seventh by position, as the kickoff says, but it is not new. The entry this branch adds is `/api/admin/drain-windows`: `git diff 14a4f38 fe021a3 -- vercel.json` shows exactly that one addition, and production at `14a4f38` has **6**.
- **The build did not refuse it.** No error in the log, state READY.
- **UNVERIFIED: the cron list as registered on the deployment.** Neither `get_deployment` nor `get_project` returns a crons field, and this session has no Vercel API token.
- Vercel also registers crons for production deployments only, so a preview has no live cron list to count.
- The count above is the configuration the deployment was built from, not a readout from the platform. The first place the platform can show seven registered crons is the project's Cron Jobs view after a production promotion.

## 4. C21 — migrations: NOT RUN (stop)

The order assumes this session can reach the production database. It cannot:
- `APP_DATABASE_URL`: **not set** in this session's shell. Checked by presence only; no value was read or printed.
- `psql`: present.
- The only local candidate is `.env.local`. **Not read**, under the standing rule never to read `.env*`. Nothing here confirms it points at the production database, and running 0091/0092 against an unverified target is the one thing this step must never do.
- The repo `CLAUDE.md` also records "No live database in this sandbox", and the standing role split has V run migrations.

Neither `psql` command was run, so there is **no migration output and no verification** of the `gemini` row or the `bench_window` columns. Both files are unchanged since `8ac9e24`.

**To unblock without putting the value in any transcript**, one of:
- **(a)** V runs the two commands from round 4 §4 in his own terminal, then reads back `SELECT id, enabled, fanout_enabled FROM stt_engine WHERE id = 'gemini';` and `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'bench_window' AND column_name LIKE 'auto_drain_refused%';`
- **(b)** V starts this `scribe` session with `APP_DATABASE_URL` already in its environment, set outside the conversation. Not typed as a `!` command, which would print the value into the transcript. Then the order is re-issued.

## 5. C22 — promotion: NOT RUN

- It comes after C21 in the order, and C21 did not run.
- The means are also missing: no Vercel CLI (`command -v vercel` → missing), no `VERCEL_TOKEN`, and the kickoff confirms the MCP has no promote tool. The only deploy-shaped MCP tool is `deploy_to_vercel`, which creates a new deployment instead of promoting this one, so I did not use it.
- **Production is unchanged:** `dpl_5FgYoTd1QBq3ypFdN36C2UEDSnHt`, `target: production`, `READY`, sha `14a4f386c16e68a611913c470585103d0171fe32` (`vinay/release-b1`), created as a redeploy of `dpl_4ZeDjRkYTJhL3h63kvpDqMcezc84`.
- No `/api/health` check was made, since there is no new production sha to confirm.
- **Order note for whoever promotes:** promote only after 0092 is applied. With the flag off, the route returns before the selector runs, so it is safe either way. But the kickoff's order (C21 then C22) is the safe habit.

## 6. C23 — eligible-window counts: NOT RUN

It needs the same database access as C21. **No counts exist.** The flag was not touched, and neither was `AUTO_DRAIN_MAX_AGE_HOURS`.

Once access exists, the read-only count is the selector's own predicates grouped by room. INFERRED; it needs 0092 applied first, because it reads the new column:
```sql
SELECT s.room_id, count(*)::int AS eligible
  FROM bench_window w
  JOIN bench_session s ON s.id = w.session_id
  JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
 WHERE w.state = 'closed'
   AND w.grid_aligned = TRUE
   AND w.room_day_id IS NOT NULL
   AND w.closed_at >= NOW() - (6 * INTERVAL '1 hour')
   AND (w.auto_drain_refused_at IS NULL OR w.auto_drain_refused_at < NOW() - (60 * INTERVAL '1 minute'))
   AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
 GROUP BY s.room_id
```
- The kickoff asks for counts "per room" before the flag decides which room. The selector's Transcript join would hide rooms with Transcript off. For the per-room picture, the same query **without** the `JOIN room … transcript_enabled` line shows every room.
- Both variants belong in the report once this runs.

## 7. Flags

**M1 — the order conflicts with the standing role split.**
- The repo `CLAUDE.md` says "No live database in this sandbox" and "You do not deploy; the Orchestrator watches it". The global rules have V run migrations.
- This kickoff moves migrations and promotion into this session. The push was explicitly named, so I did it.
- For migrations and promotion, the tooling this session actually has settled it before any judgement was needed (§4, §5).
- If this move is meant to be standing, the environment has to change first. The rules should change in the same place, so the next order doesn't meet the same wall.

**M2 — G11 cannot be verified from this session as worded.** See §3. The platform can show registered crons only after a production promotion, and only to a session with Vercel API access.

**M3 — C18 correction.** FIX4 marked the Vercel build command UNVERIFIED. The preview build log settles it: `Running "npm run build"` → `next build`. No tests run on a Vercel build.

**M4 — the Refuter's O1 stands for the tests.** The C16 `model` cases in `s1-emotion-zero-scored.test.ts` mock `scoreSegments` past the `client.ts:91` guard, so they prove the store's comparison, not a reachable production path. The comment now says so. The tests are unchanged, as ordered.

## 8. State

- `git status --porcelain | grep -v '^??'` → empty.
- Local `HEAD` = `origin/vinay/s1-auto-drain` = `fe021a3`.
- Untracked: this report and earlier rounds' bus papers.
- **Stopped at C21.** Nothing past it was attempted.
