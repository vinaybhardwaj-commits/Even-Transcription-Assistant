# ETA TIER 2 SLICE B BUILD REPORT — jobs — 12 Sep 2026

**Commit** `c5b5eb1` on `vinay/tier2-b`, branched from `vinay/release-b1` @ `aed0962`. Not pushed. `main` and `vinay/release-b1` untouched.

**Gates** (all four, final tree):
- `npx tsc --noEmit` exit 0.
- `npm test`: `Tests 1871 passed (1871)`, 84 files. Baseline `1838` in 82 — **+33 tests, +2 files**, none removed.
- `npm run build` exit 0 · `npm run check:silent`: the same **9** accepted findings, none in a Slice B file.
- No Swift gate: `apps/room-recorder` untouched. **0082 was not run anywhere; nothing published.**

**Files**: 19 files, +1774/−9. `lib/jobs/**`, `app/api/jobs/**`, `vercel.json`, `db/migrations/0082_scribe_job.sql`, `lib/mcp/tools/jobs.ts` — §1's Slice B row — plus three outside it, each required by the order: `lib/mcp/handler.ts` (register `JOB_TOOLS`), `lib/mcp/tools/bench.ts` (`async:true` on the two range tools), `lib/room-install.ts` (the `channel_reported` dedupe).

**What was built**
- **0082** `scribe_job` exactly as §3 lists it, plus `scribe_job_status_created_idx (status, created_at)`. `kind` is deliberately **not** CHECKed: a kind added by a later slice must not need a migration, and an unknown kind is refused at submit where the error can name the allowed list.
- **Runner** `POST|GET /api/jobs/run`, `maxDuration 300`. Claims ≤ 3, lease 240 s, one step per claim, `attempts > 3 → failed`. **GET as well as POST, because Vercel Cron issues GET** — a POST-only route would have been a cron that never fired. `CRON_SECRET` is accepted alongside `JOBS_RUNNER_SECRET` for the same reason. Secret unset → **503 and nothing runs**.
- **Kinds**: `transcribe_range` and `stitch` built; `audio_measure`, `emotion_clip`, `diarize_clip`, `stt_fanout`, `day_manifest` registered as stubs failing `not_implemented`, each with its real scope and a real `parseArgs`.
- **Tools**: `scribe_job_submit` (invoke), `scribe_job_status` (read), `scribe_job_list` (read), `scribe_job_cancel` (write). `scribe_transcribe_range` and `scribe_extract_audio` gained `async:true`; the synchronous path is untouched and stays the default.
- **Additions**: `scribe_audit_recent` (read, allow-listed actions, no free-text argument); `install.channel_reported` deduped to one row per (install_id, channel, minute).

**A defect the tests caught before it shipped.** `saveStep` releases the lease by nulling it, but the claim predicate required `lease_until IS NOT NULL` on the running branch — so **every job that successfully advanced a step became unclaimable for ever**, a queue that silently stopped after one step per job. The crash-resume test found it. A running row is claimable when nobody holds it: an expired lease **or** a null one.

**SQL (all INFERRED; no live database)**
- Claim: `WITH claimable AS (SELECT id FROM scribe_job WHERE (status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now()))) ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED) UPDATE scribe_job j SET status = 'running', attempts = j.attempts + 1, lease_until = now() + make_interval(secs => ?), started_at = COALESCE(j.started_at, now()), updated_at = now() FROM claimable c WHERE j.id = c.id RETURNING j.<15 cols>`
- Step: `UPDATE scribe_job SET step = ?, progress = ?::jsonb, lease_until = NULL, status = 'running', updated_at = now() WHERE id = ? AND status = 'running'`
- Finish / fail / cancel: `UPDATE scribe_job SET status = 'done'|'failed'|'cancelled', … lease_until = NULL, finished_at = now(), updated_at = now() WHERE id = ?` — cancel additionally `AND status IN ('queued','running')` and RETURNs the row.
- Insert: `INSERT INTO scribe_job (id, kind, args, actor) VALUES (?, ?, ?::jsonb, ?) RETURNING <15 cols>`. List: `… WHERE (?::text IS NULL OR status = ?::text) AND (?::text IS NULL OR kind = ?::text) ORDER BY created_at DESC LIMIT ?`.
- Audit read: `SELECT action, actor_type, actor_id, target_type, target_id, metadata_json, created_at::text FROM audit_log WHERE action = ANY(?) AND (?::text IS NULL OR action = ?::text) AND created_at >= ?::timestamptz ORDER BY created_at DESC LIMIT ?`
- **`make_interval(secs => ?)`** is the one construct I could not test: a literal `now() + '240 seconds'::interval` would have been simpler but not parameterisable. Wants live eyes.

**Seams I interpreted differently from the spec**
1. **`transcribe_range` is THREE steps, not four.** §3 says resolve → join → transcribe → write. A fourth step would have to carry Whisper's **transcript** from `transcribe` to `write` through `scribe_job.progress` — patient speech, at rest, in a new table, readable by every token with `read` via `scribe_job_status`. So the write happens inside the transcribe step, which already holds the text, and `progress` never carries a word of it. **Needs a ruling if four steps were load-bearing.**
2. **The transcribe step does not yet write cues.** It returns the transcript in `result`; the scratch-graph turn-writer lives inside `scribe_transcribe_range`'s handler in `bench.ts`, which is outside Slice B's file table. Extracting it is a refactor, not a job. `dry_run` is carried on the result so a caller can see which it got.
3. **`stitch` reuses the tool's helpers rather than `scribe_stitch`** — §4.3 defines that tool in Slice C. This kind is the step machine only; the tool that submits it arrives with C.
4. **The runner answers GET.** §3 says POST; Vercel Cron only issues GET. Both verbs share one guard.
5. **`scribe_job_submit` passes `actor: null`.** The MCP tool handler is given `ToolArgs` and `ToolContext`, neither of which carries the resolved principal — wiring §2.3's actor through to a job needs a `registry.ts` signature change, outside this slice. Jobs submitted by a route or a later slice can set it; the column and the view already carry it.
6. **`install.channel_reported`'s dedupe window is 2 minutes on a per-minute key**, not 1. The key carries the minute, so the window only has to outlive one minute's polls; a genuine transition in the next minute writes its own row.
7. **The audit reader is allow-listed to five actions** and has no free-text argument. `audit_log.metadata_json` is written by many callers and this must not become a way to read whatever any of them stored.

**V's manual steps.** Apply 0082 to the preview before promoting, the way 0081 was: `curl -X POST -H "Authorization: Bearer $MIGRATION_SECRET" https://<preview-host>/api/run-migrations`. Set `JOBS_RUNNER_SECRET` on the deployment — **until it is set the runner answers 503 and no job ever runs**, which is the safe failure but is silent. `CRON_SECRET` optional.

**Subagents:** none.

## Fix-up 1 — on the three rulings
**(1) and (2) accepted as built**; seams 1 and 2 close. (2) is now stated where a caller will read it: `scribe_transcribe_range`'s description says `async:true` returns text and a `transcription_run` and **writes no turn cues — those arrive with Slice C**.
**(3)** `ToolContext` gains `actor: string` — the resolved `SCRIBE_MCP_TOKENS` actor, `mcp:`-prefixed once by `mcpActorId`, defaulting to `mcp:operator-v1` for the single-token fallback so a job's actor is never blank. `handler.ts` fills it from the principal it had already verified, and `scribe_job_submit` plus both `async:true` paths record it — replacing the `actor: null` seam 5 flagged.
**Tests +3** (1874, was 1871): a `SCRIBE_MCP_TOKENS` actor lands on the INSERT's actor parameter **end to end** (`checkMcpBearer` → `handleMcpRpc` → `submitJob` → `insertJob`) as `mcp:operator-v`; the fallback records `mcp:operator-v1`, never null; and the `ToolContext` shape is pinned.
**Worth knowing**: `tsconfig.json` EXCLUDES `tests`, so adding a required field to `ToolContext` was not a compile error in any test file — the existing `ctx` literals still pass `undefined` for it silently. The new test pins the type by reading the source instead. Gates: tsc 0 · **1874 passed (1874)** · build 0 · check:silent the same 9. Branch `vinay/tier2-b` pushed.

## Fix-up 2 — the Refuter's five (verdict: no)
**(1) A real bug, and my own stitch test missed it** by only checking `planPieces` purity, never an end-to-end multi-claim run. The cap read `attempts`, which counts CLAIMS: a 61-minute stitch is one resolve plus three joins — four claims, zero errors — and would have been failed while succeeding. 0082 (run nowhere) gains `failures int NOT NULL DEFAULT 0`; `attempts` keeps counting claims as progress and liveness; the cap reads `failures` only. New test drives a six-claim job to `done` with `failures 0`.
**(2)** `result` is pointers: transcribe_range `{transcription_run_id, chars, language, segments, …}`, stitch `{start, end, clip_key}`. Presigned URLs are minted on demand by `scribe_job_status` and **require invoke** — a link fetches audio, which is stronger than reading the row. A test greps a completed transcribe job's status payload for the fixture's words and finds none; a second reads the kind's source and pins that `doneWith` has no `transcript` key. **`transcription_run_id` is null until Slice C**: every writer lives in `lib/stt/**` and §4.5 gives that persistence to C — the key ships now so the shape does not change when C fills it.
**(3)** `saveStep` and `finishJob` carry `AND status = 'running'`. The cancel-race test asserts a `done` write landing after a mid-step cancel matches no row: the last writer does not win, the cancel does.
**(4)** Each kind's declared scope is enforced at submit through a new `ToolScopeError` the handler renders as −32001. **`failSafe` now rethrows it** — flattening a permission refusal into `{degraded:true}` would tell a caller the data was unavailable when it was withheld, and turn a 403 into a 200.
**(5)** The claim fake holds its lock across an await and reads `FOR UPDATE SKIP LOCKED` from the statement. **Proven by deleting the clause: four tests fail, including "a job was claimed twice: expected 3 to be 6"**; restored and green.
**Gates**: tsc 0 · `npm test` **1885 passed (1885)**, 84 files (was 1874) · build 0 · check:silent the same 9. 0082 still run nowhere. Branch `vinay/tier2-b` pushed.

