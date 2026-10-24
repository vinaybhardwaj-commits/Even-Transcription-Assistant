# S6-live runbook and readiness audit (for fable; NOT executed by the builder)
Branch spine/s6live-readiness. Facts marked UNVERIFIED were not checked on the box (this lane cannot reach it).

## 1. Precondition (fable's rule)
**Lane B (spine/sigb-signals, the signal state machine) must be merged AND deployed before ANY stage goes live.** Nothing in this branch depends on B's code.

## 2. Audit: enqueue -> claim -> executor -> report -> artefact -> readers
Path: cron `/api/cron/spine` (5 min) runs ingest, merge, `runSpineEnqueue` (lib/spine/enqueue-store.ts) -> spine_job `queued` -> runner `POST /api/spine/claim {live:true}` (app/api/spine/claim/route.ts) -> `executors.py` -> `POST /api/spine/report` -> `reportJob` (lib/spine/jobs.ts) -> one spine_artefact row (create-only) + one spine_tick.
Fixed in this branch (each has a killed mutant, see the report):
- F1 claim/route.ts:30 — `jobs=shadow` did not stop a LIVE claim (only the enqueuer honoured the cap): rollback "jobs=shadow" would not have stopped anything. A live claim now needs `jobs=live`.
- F2 executors.py recut() — the cutter's :23-:38 timer gap was a `transient` result: it burned an attempt (6 allowed), took the 2/6/18 min backoff and ticked the breaker every hour; one failure with no history opens the breaker 30 min. Now `release` (attempt given back, no tick), as K lanes already do.
- F3 enqueue-store.ts INSERT_SQL — a job the runner HELD as `blocked` (no consult_uid link) stayed held for ever: `enqueue({unblock})` has no caller. The cron's enqueue pass now revives a held `queued`/infinity row once an active consult_uid link exists.
Gaps NOT fixed (outside the small/in-scope bar), with file:line:
- G1 (RESOLVED by room scoping, ff560637; see step 3) was: NO per-room scoping. `mode.<stage>=live` plans every confirmed/candidate encounter closed >15 min inside the 72 h horizon, ALL rooms (enqueue-store.ts SELECT_SQL, `READ_LIMIT` 2000). Flipping recut live queues up to hundreds of recuts at once. PROPOSAL: spine_config `live_rooms` (json array of room_id; missing/malformed = no room live); SELECT_SQL gains room_id, `planJobs` plans `queued` only when the encounter's room is listed, else `shadow`. Needs a P2 builder + refuter; do it before step (c). Until then (c) cannot be scoped: use the date lever below.
- G2 Date lever in lieu of G1: none exists in config (horizon is a code constant HORIZON_MS, merge.ts). Do not flip with a backlog; check `spine_job` counts first (section 4).
- G3 Throughput: live claims `limit 1` per pass and the loop sleeps SPINE_POLL_SECONDS (60) after EVERY pass, including a blocked/released one (runner.py run_once / main). Backlog drains at most ~1 job per minute + job time; encounters without a consult_uid link each burn one poll before they are held. Proposal: claim route skips jobs with no link when live (jobs.ts claimJobs withUid) or the runner skips the sleep after blocked/release.
- G4 First-failure breaker: no minimum sample (retry.ts breakerOpen). With empty history one transient (lock_busy, gpu_busy, timeout) opens the stage for 30 min. Expected, but watch it on day 1.
- G5 In-flight job ignores a later flip: mode/kill_switch are read at claim only (runner.py _handle). A recut can run up to 14 min (CHILD_TIMEOUT_S 840) after the flip. To stop NOW: stop the unit (SIGTERM kills the child's process group, exit 143).
- G6 Retry vs sha: a re-run recut of the same tape must give the same consult.flac bytes, else `reportJob` fails the job permanent `sha_conflict` (jobs.ts recordArtefact; nothing is overwritten). Determinism of the cutter's FLAC is UNVERIFIED. The artefact cfg8 is sha256(index signature)[:8] and version is the constant "v1" (executors.py _recut_done).
- G7 Artefact stage names: the runner writes stage `recut` / `acoustics` / `nemotron`; the S3 indexer writes `cut` / `diarize` etc. (artefacts.ts mapRow). They do not collide. Readers of the runner's rows today: only the explorer (explorer-read.ts:217) and the enqueuer's STAGE_NEEDS gate (acoustics, nemotron wait for recut `done`). pipeline-view counts spine_job only. The collector / S7a do not read them yet (CLI templates only, no executor).
- G8 Dead alerts are off by default: `spine_config dead_alert=live` is needed for the room_alert_outbox `heal_escalated` row (jobs.ts opsAlertNotifier; relay side UNVERIFIED). `reapExhausted` runs on claim only, so a stopped runner reaps nothing.
- G9 Box env: the hourly cutter unit says CONSULT_R2_WRITE_FILE and CONSULT_DIARIZE_PKG_DIR / CONSULT_DIARIZE_MODULE are set for it (cutter-hourly.service:5); recut-queue.service shows no Environment line (a drop-in may exist, UNVERIFIED). The recut child inherits ONLY the runner's env: copy whatever the recut-queue process has, or clips stay `pending_no_credential`. The runner ignores `~/eta-data/consult/recut.stop` (recut_queue's stop file).
- G10 Exit 3 (a refusal, or an executor not configured) is `RestartPreventExitStatus`: a flip to off between claim and execute stops the unit for good until someone restarts it. By design; know it.
- G11 No artefact bytes leave the box: store `box`, object_key relative (`consult.flac`, `tracks/<file>`), sha256 only. Nobody off the box can fetch them. Intended for S6; S7a must not assume R2.
- G12 `clip_lanes` keeps its own root and `~/gpu.lock` (hard-coded in the lab), so SPINE_DATA_DIR / SPINE_GPU_LOCK move only the runner's lock/track paths (executors.py F8 note).

## 3. Runbook (fable executes)
Host: the T4 box that has the cutter and the lab (UNVERIFIED which hostname; the cutter units use `~/oc/consult/cutter-deploy` + `~/oc/consult/cutter-venv`). It must have: `nice`, python3 >= 3.9, network to the app, the cutter checkout/venv, the eta-lab checkout holding `kit/reb/clip_lanes.py`, and `~/eta-data` (consult/, reb/).
Install (runner is stdlib only): copy `tools/eta-spine/runner.py` AND `executors.py` to `~/oc/spine/` (the unit's ExecStart is `%h/oc/spine/runner.py`; executors.py is imported from the same directory). Unit: `tools/eta-spine/units/spine-runner.service` -> `~/.config/systemd/user/`.
Env file `~/.config/spine-runner/env` (mode 600), names only:
  SPINE_BASE_URL            https://<app host>
  SPINE_BEARER_TOKEN        same value as the app's SPINE_BEARER_TOKEN (Vercel env)
  SPINE_CUTTER_DIR / SPINE_CUTTER_PY   (recut) e.g. ~/oc/consult/cutter-deploy and ~/oc/consult/cutter-venv/bin/python (UNVERIFIED on the box)
  SPINE_LAB_DIR / SPINE_LAB_PY         (acoustics, nemotron) DIR is the directory that CONTAINS kit/ ; PY the lab venv python
  plus whatever the recut child needs (G9): CONSULT_R2_WRITE_FILE, CONSULT_DIARIZE_PKG_DIR, CONSULT_DIARIZE_MODULE
  optional: SPINE_DATA_DIR (default ~/eta-data), SPINE_GPU_LOCK, SPINE_POLL_SECONDS (60), SPINE_RUNNER_OWNER, SPINE_HOURLY_FROM_MIN/_TO_MIN (the app reads the same names; keep both sides equal or leave at 25/45)
Steps:
 0. Precondition: the B PR (spine/sigb-signals, the signal state machine) MUST be merged and deployed to the runner box BEFORE install. main's signal handler deadlocks on a single SIGTERM (handler -> kill_children -> communicate/wait re-enters Popen while the outer communicate holds its waitpid lock; S6 readiness refute item 6): `systemctl stop` then hangs until systemd SIGKILLs the cgroup after TimeoutStopSec (90 s default), exit not 143. Run `python3 -m pytest tools/eta-spine` on the box checkout.
 1. `systemctl --user daemon-reload; systemctl --user enable --now spine-runner` — WITHOUT --live (would_run). Needs spine_config `jobs=shadow` + `mode.<stage>=shadow`. This proves ONLY auth and connectivity: each would_run claim pass returns 200 with an empty list, because shadow rows are never claimable (refute-proven: 30 enqueue+would_run passes = 0 jobs). Expect no `claim status=` lines, no `would_run job=..` lines, no tool process. For a real dry run, seed ONE queued job for ONE test room under the room scoping in step 3 (a queued row for a room listed in `mode.<stage>.rooms`) and run with --live on that room only.
 2. (a) B merged and deployed to the box. (b) `spine_config jobs=live` (also `kill_switch=false`; optionally `dead_alert=live`). Only recut first: `mode.recut=live`, acoustics/nemotron stay shadow (they wait on recut `done` anyway, STAGE_NEEDS).
 3. (c) Per-room flip (room scoping, `mode.<stage> = {"mode":"live","rooms":[...]}`; one room rule for enqueue, claim and report). Sequence:
    - `mode.recut = {"mode":"live","rooms":["<room_a>"]}`: one room, one stage first. Rooms outside the list stay shadow.
    - Watch `spine_job` and `spine_artefact` counts (checks below) for that room: queued falls, one artefact per done job, no failed/dead.
    - Add the next room to the `rooms` array, watch again; repeat. Only after the recut rooms are clean, repeat the same sequence for acoustics, then nemotron.
 4. (d) (after steps 2 and 3 are in place) Edit the unit: ExecStart gets ` --live`; `systemctl --user daemon-reload; systemctl --user restart spine-runner`. The first live pass logs `stage=recut outcome=...` (codes only, never a uid or argv).
 5. After 5 clean recuts: `mode.acoustics=live` (then `mode.nemotron=live`). K lanes are never handed out :20-:45 IST.
Checks to watch (counts only):
  SELECT stage, status, count(*) FROM spine_job GROUP BY 1,2;  — queued must fall; leased > 1 per stage means two runners.
  SELECT stage, status, count(*) FROM spine_artefact WHERE store='box' GROUP BY 1,2;  — one row per done job.
  SELECT last_error_code, count(*) FROM spine_job WHERE status IN ('failed','dead') GROUP BY 1;  — `sha_conflict` = G6; `lease_expired` = a runner died.
  Breaker: spine_tick kind `attempt:<stage>`, a failed:1 in the last 30 min with >=30% of the last 20 closes the stage (claims return nothing). Dead alerts: room_alert_outbox rows `spine-<stage>` (needs dead_alert=live). Rooms Live pipeline view shows done/queued/failed/dead per stage.
Rollback (fastest first):
  - Stop NOW incl. a running cut: `systemctl --user stop spine-runner` (kills the child group).
  - No new claims: `kill_switch=true` (any non-false value counts as killed), or `jobs=off` (or `shadow`, F1), or `mode.<stage>=off`.
  - Back to would_run (or narrow the `rooms` array to drop a room): remove ` --live`, daemon-reload, restart. Queued live jobs stay queued and resume when the mode returns to live; shadow reports for a live stage are re-queued (N3), never consumed.
