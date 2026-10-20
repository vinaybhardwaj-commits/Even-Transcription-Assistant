# SPINE-S6-BUILD — live free stages (recut, acoustics, nemotron). Branch spine/s6-free off spine/s5-queue 1db61d55. Host c3.
Every stage stays mode=shadow: nothing here runs without `--live` AND the stage mode live (go-live is fable's). Paid stages unchanged (never claimable).
## Changed
- NEW tools/eta-spine/executors.py: per-uid subprocess executors by path from env (SPINE_CUTTER_DIR/_PY, SPINE_LAB_DIR/_PY; optional SPINE_DATA_DIR, SPINE_GPU_LOCK). No withheld module read or imported.
  recut `cutter.run --once --only UID --recut`; acoustics/nemotron `kit.reb.clip_lanes --lane L --consult UID --write` (+ `--worker-status worker` for nemotron).
  Locks: cutter.lock probed + the cutter's own {"locked"}; :35 gap (180 s after, 720 s before); K lanes hold `_hourly.lock` for the child's whole run; gpu.lock only PROBED (clip_lanes holds it per inference). All busy = transient.
  Map: cut/written/skipped_existing -> done + artefact {engine,version,cfg8,store=box,sha256,object_key}; silent_audio, blind_room_day, blind_refused, rc 2 -> permanent; lock/gpu/gap/timeout/no_tape/not_cut/stopped/any other rc -> transient. No uid/argv/output is logged.
- tools/eta-spine/runner.py: --live uses the executors (old generic rc map removed); unconfigured executor = release + exit 3; live claims 1 job per pass; report carries `artefact`. N4: a refusal releases the rest of the claim.
- lib/spine/jobs.ts, artefact.ts, claim + report routes: live claim returns `consult_uid` (spine_link, active; null if none; never on a would_run claim); done report may carry an artefact REF (create-only spine_artefact; same sha idempotent; other sha never overwrites and the job fails permanent `sha_conflict`).
- N3: `enqueue({requeueShadow:true})` puts ONE `shadow` row back to queued (no other status touched); a `shadow` report for a stage live NOW is stored as release (re-queued). No migration added (0173 is the spine's; oauth branches also carry a 0173 file: gating-lead's numbering, untouched).
## Tests (own logs in .bc/)
- pytest tools/eta-spine/tests: `64 passed in 1.80s` (executors 43 incl. --only argv per lane, lock contention both directions with real flocks, error map, sha256; runner N4).
- vitest spine (queue, queue-pg, schema-pg, s6-pg): `Test Files 4 passed (4) / Tests 57 passed (57)`; s6-pg 12/12 on postgres:16 (N3 x4, consult_uid x2, artefact x4, parse).
- typecheck + typecheck:tests: 0. Full vitest (4 workers, --minWorkers=1): `Test Files 2 failed | 452 passed | 1 skipped (455) / Tests 2 failed | 9386 passed | 5 skipped (9393)`. The 2 failures (e11-silent-room-window, no-identity-literals) are the same two the S5 R2 refute measured at base; no spine path in their diffs.
- npm run build: Compiled successfully. check:silent: `Found 9` (accepted baseline, 0 spine). swift build/test: N/A on Linux. check-number-words: N/A (no change).
- Mutants (15): requeue status guard dropped, modeOf flip removed, sha conflict ignored, active-link filter dropped, silent_audio->transient, hourly lock check/release dropped, :35 pre-gap dropped, cutter probe dropped, {"locked"} ignored, gpu probe dropped, sha stubbed, uid regex loosened, N4 release dropped, nemotron --worker-status dropped: 15/15 killed.
## Assumptions
- A job with no consult_uid link (proxy-only encounter) is permanent `no_consult_uid` (visible in failed; a later link needs a new cut_version/enqueue). The Pulse-derived uid travels only on a live claim.
- Artefact sha for recut = consult.flac found via the cutter's own index row (cfg8 = sha256(signature)[:8], version v1); for lanes = newest track file (sha of its bytes), ref is `tracks/<file>` with no date/room/uid. Sha conflict returns 200 with status failed (not 409) because the job must leave `leased`.
- Child timeout 840 s (under the 15 min lease). UNVERIFIED on a real box: clip_lanes run as `-m kit.reb.clip_lanes` from SPINE_LAB_DIR and `hourly.sh` holding `_hourly.lock` for its run (only the plan states it); the cutter's skip reason is read from its stderr line `not done: skip <reason>` (the summary JSON has no reason).
## Open risks
- Nothing ran against real engines or data (fake CLIs only). N1 (relay kind) and N2 (spine_tick index/retention) untouched, per brief. The spine-runner.service unit has no SPINE_CUTTER_*/SPINE_LAB_* env yet: add when going live.
