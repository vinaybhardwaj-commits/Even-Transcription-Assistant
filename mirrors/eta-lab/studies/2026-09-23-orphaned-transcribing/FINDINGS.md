# Orphaned transcribing windows — root cause (23 Sep 2026)

Read-only against production. Order: `orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain.md`.

## Root cause: 56/56, one cause

Every orphaned window's LATEST `room_window` job (`scribe_job`) has `status='cancelled'`:
- 50: `error='cancelled_for_serial_retry'`
- 2: `error='cancelled_for_serial_force_drain'`
- 4: cancelled, no/other detail (2 with a step recorded — mid-flight; 2 with none — before first claim)

`cancelJob()` (`lib/jobs/store.ts`) is a generic job-system primitive — it sets `scribe_job.status='cancelled'` and touches nothing else. Every *ordinary* room_window failure runs through `lib/stt/room-drain.ts`'s own `recordFailure`, which is what moves `bench_window` back to `closed` (or parks it `failed`). A job cancelled from *outside* that path — here, someone/something enforcing one-drainer-at-a-time serial concurrency, a legitimate operational action taken tonight — leaves `bench_window.state='transcribing'` forever: not `closed` (auto-drain only re-offers `state='closed'`) and not `failed` (nothing flags it).

Ruled out with evidence: `router_job_lost` (already fixed, merged 6fef31d, unrelated — none of the 56 carry that error), attempt exhaustion (`stt_subject_job.attempts` 0–2 on all 56, bound is 3), a missing clip (46/56 already have one; the other 10 re-join fine — `clip_r2_key` isn't a precondition of `roomWindowPrepare`), lease expiry (no jobs stuck `running` past a lease — all cleanly terminal).

This is a **generic gap**: *any* cancelled-from-outside or bookkeeping-bypassed-failed room_window job strands its window the same way, not just tonight's serial-retry cancellations.

## Reaper: did not exist, built one

Checked `lib/bench-reaper*`, `app/api/admin/reap-stuck`, `lib/bench-orphan.ts` — none touch `bench_window.state`. Built `lib/room-window-reaper-core.ts` (pure) + `lib/room-window-reaper.ts` (DB wrapper) + wired into the *existing* hourly `reap-stuck` cron (same pattern the 19 Aug bench-session sweep used to extend that same route) — no new route, no new cron entry. Branch: `vinay/room-window-reaper`, off `origin/vinay/s1-auto-drain`.

Logic mirrors `recordFailure` exactly: stale (job terminal >15 min) + `cancelled`/`failed` job → `bench_window` closed/failed, `stt_subject_job` queued/failed by the same attempts-bound test — but never increments `attempts` (a cancelled job never spent a real attempt). Never touches `done`, still-live (`queued`/`running`), or no-job windows.

23 tests (pure core + injected-sql wrapper, mirroring `bench-reaper.test.ts`'s shape), 3 mutations verified killed by hand (staleness check removed, exhausted-bound off-by-one, `done` included), reverted clean. Full touched-suite green. typecheck + typecheck:tests clean.

## Recovery

See `RECOVERY.sql` — audited, transactional, STEP 0 confirms the set before writing. Not run (read-only). Expected: 56 windows → `closed`; then direct room_window submission per id (bypasses the age horizon — `drainRoomWindow` itself has none, only auto-drain's *scan* does), ~1–3h of drainer time, competing with tonight's other backlog work on the same shared Whisper/join/router capacity.
