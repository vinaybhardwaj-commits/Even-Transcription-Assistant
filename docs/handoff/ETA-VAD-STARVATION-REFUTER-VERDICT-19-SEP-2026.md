# Refutation: vinay/vad-starvation (85f8c82, c33148d on 843e7b2) + ~/eta-router (c8a75cb, 564eb41)
Refuter: read + run only. Nothing edited, committed, pushed, restarted. No text/PHI printed.

## Verdict: SOUND WITH FINDINGS.  Restart safe: YES when I ran the precheck (RESTART SAFE, 0 in flight); NO if any router job is queued or running at kickstart time.

## Evidence index (all in this directory)
- refute-router-exp.py / .out    router's REAL functions, old vs new (engines stubbed, temp job dir): E1 fallback, E2 status, E3 job_verdict, E4 run_job
- refute-gen-jobs.py + vad-jobs/ REAL run_job replies (silent / partial / ran_found_nothing) - no text
- zz-refute-vad-app.test.ts       poll -> writeRoutedRun -> finish -> tape on real postgres:16, async sessions (6 passed). NOT committed anywhere.
- router-restart-precheck.sh      read-only; run it at kickstart time
- mini-gate: /tmp/mini-gate.sh (go iff verdict !~ ^STOP_ and diarize_ms < 400; free_pct ignored; wait loop has NO iteration cap)

## Baseline
router_server.py.bak-vadfallback-20260919094403 == router_server.py.bak-w1-lang-20260914143924 (byte-identical). Brief's lines hold there:
:262 get_speech_timestamps(...) no threshold; :286-288 comment+stderr+`return [], "silero-vad-no-speech"`; :289 except; :290-291 stderr + fixed-window fallback.
UNVERIFIED: that this equals what pid 49336 (started 14 Sep 14:53) is running; a running process's source cannot be read. Supported by the file being unchanged since the 14 Sep backup.

## Threshold (the stated blocking condition) - NOT triggered
VAD_THRESHOLD = float(env ETA_VAD_THRESHOLD, "0.5") at :76, passed at :273. silero_vad 6.2.1 default is 0.5. E1 captured threshold=0.5 actually passed.
launchd plist sets only ETA_DEFAULT_CANDIDATES, ETA_MAX_INFLIGHT=1, PATH: nothing overrides it on restart.

## 1 Silero-silent window: does the record survive? YES (V1/V2/V3)
Real run_job reply -> routeAdapter.poll -> writeRoutedRun -> finish, on Postgres:
 run row: engine=route chars=0 metrics_json.engine_run = {status: silent_skipped, engines_skipped: true, windows_total: 2, windows_skipped: 2, segmentation_method: fixed-window-vad-empty}
 window: `transcribed` on BOTH the drain path (was transcribing) and the direct path (was closed); legacy job `done`, last_error NULL.
 tape (assembleTape): engines_skipped=true, skip_reason=fixed-window-vad-empty.
 Pre-fix reply (no status/segmentation): engine_run ABSENT, tape not skipped (V6). Partial (2 of 3 sub-windows skipped): engines_skipped=false, counts kept (V4).

## Scribe's collision claim: TRUE (V3)
writeRoutedRun (room-drain.ts:1026-1117) issues one CTE: DELETE FROM transcription_run + INSERT INTO transcription_run. Nothing else.
finish touches bench_window + stt_subject_job only. Disjoint tables. Ran them truly concurrently (Promise.all of two psql sessions): both landed.

## 2 Fallback fires on a confident empty answer: YES (E1)
Silero returning [] with no exception (and real Silero on above-gate noise): old -> 0 spans, "silero-vad-no-speech"; new -> 2 fixed windows, "fixed-window-vad-empty".

## 3 Zero characters + success-looking state: STILL REACHABLE, three ways
All land `transcribed` with 0 chars: (a) engine_run.engines_skipped=true (router said it ran nothing); (b) engine_run present, engines_skipped=false (engines ran, produced nothing / all rejected); (c) engine_run absent (pre-fix rows, other engines).
(a) and (b) are new and distinguishable; window `state` does not encode either. `silent` state is only reachable from Whisper's own empty_transcript, never from the router's verdict.
The tape UI (components/) has no change: engines_skipped/skip_reason are in the API payload only.

## FINDING - silent_skipped over-claims (NON-BLOCKING, highest priority of those)
router_server.py:609  status = "silent_skipped" if (not segments and n_skipped_silent > 0)  -> zero SEGMENTS, not zero ENGINE RUNS.
router_server.py:712  job_verdict: same test lifted; its docstring (:681) says "NO ENGINE RAN ANYWHERE".
Reproduced 3 ways: E2 (60 s half silence/half noise: 2 engine calls made, status silent_skipped, n_engine_segments=2); E3 (job_verdict([ran-found-nothing, skipped]) -> silent_skipped);
E4-equivalent through the real run_job (ran_found_nothing.json: status silent_skipped, windows_skipped 1 of 2) and on the row (V5: engines_skipped=true stored).
Effect: a window that WAS listened to is recorded as "nobody listened", the exact confusion the change exists to remove, pointed the other way.
Line 609 predates the fix; the fallback widens who reaches it, and job_verdict is new code that carries it. Fix shape: skip iff n_engine_segments == 0 (router already emits it).

## FINDING - restart (BLOCKING for the restart action if anything is in flight; NOT caused by this diff; CLEARED right now)
run_job runs in a daemon thread (:861). No startup recovery exists (grep: no on_event/lifespan). A killed job's file stays state=running.
App roomWindowPoll (room-drain.ts ~1290-1330) maps running -> still_running with no stall detection, by design ("never submits", files expire in an hour).
Sweep: _cleanup_old_jobs runs only inside POST /route/job (:863), TTL 3600 s by mtime -> a stranded window sits `transcribing` >= 1 h, unbounded if nothing submits; then GET 404 "unknown job_id" -> adapter terminal:true -> recordFailure -> window closed, 1 of 3 attempts spent -> re-drained.
Snapshot now: router jobs/ 12 files, all done, 0 queued/running; DB: 0 windows transcribing, 0 room_window scribe_jobs queued/running (backlog: 2303 closed windows, 376 queued legacy rows, so jobs WILL arrive if auto-drain is on).
Downtime itself is cheap: a failed poll has no `state` -> terminal:false -> retried, no attempt burned; a SUBMIT in the gap burns 1 of DRAIN_MAX_ATTEMPTS=3.
`launchctl kickstart -k`: SIGTERM, launchd ExitTimeOut default 20 s then SIGKILL; daemon threads die; eta-job-* tmp dirs leak (finally never runs). KeepAlive=true.
This fix lengthens the exposure: a starved window used to finish in seconds; it now runs up to ~32 engine calls per 900 s window (ETA_MAX_INFLIGHT=1 in the plist -> serial).

## FINDING - fallback quality and cost UNVERIFIED (NON-BLOCKING)
No committed test and no measurement shows the fixed-window fallback recovers text on real starved audio; the router half has no automated tests at all (repo has only .gitignore + router_server.py).
Fixed 30 s / 1 s-overlap windows above the RMS gate (0.008 / 0.02) go to engines; noise-driven hallucination is the Whisper failure the phrase-loop work just measured. Watch fixed-window-vad-empty counts and chars/speech-sec after restart.
Existing starved windows are not re-drained: routed windows with >=60 s diarized speech: 40; under 200 chars: 20; zero chars: 9 (my cut; brief's 14/45 is a different cut, same direction, worse).

## R58 (item 5): the claim is credible, and it is a fragile test
e31b-atomicity.test.ts R58 case 2 (12 wrong pins then rate_limited) depends on lib/lockout.ts:154: any pin_attempt in the last 1 second. After the 12th insert the test makes two more docker-exec round trips (attempts(), preAttemptCheck) before the gate reads; if those exceed ~1 s the newest row is stale and the gate answers ok.
Not touched by this branch (git diff 843e7b2..c33148d: no lockout/clinician/pin/auth file). I did NOT induce the failure (would add load to a Mini already at STOP); mechanism confirmed by reading only. Passed in every run of mine.

## Tests I ran
typecheck exit 0; typecheck:tests exit 0; npx vitest run (2 forks, detached worktree at c33148d, clean tree) -> 132 files / 3019 passed / 0 failed (matches scribe).
vad-starvation.test.ts 8 passed; vad-starvation-job-path.test.ts 4 passed; with room-day-tape.test.ts 35 passed.
Not covered by any committed test: writeRoutedRun storing engine_run, finish, assembleTape's new fields, the UI, anything in the router.
Mini: gate checked before every heavy step; never STOP_ at a step; free_pct ignored per brief.
