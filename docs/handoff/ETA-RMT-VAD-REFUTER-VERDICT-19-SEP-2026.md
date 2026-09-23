# Refuter verdict — vinay/route-metrics-truth @ 5bdffc0 and vinay/vad-starvation @ 8d6b6e8

VERDICT route-metrics-truth: SOUND WITH FINDINGS. VERDICT vad-starvation @ 8d6b6e8: SOUND WITH FINDINGS. Merge in either order: yes.
No BLOCKING finding. Finding 1 is the one to fix before more rows accrue.

Counts, ids and timings only. No transcript text, no room/patient labels, no credentials.
Method: own detached worktrees (refute-rmt @5bdffc0, refute-vad @8d6b6e8, refute-mut @8d6b6e8, disposable); router source READ ONLY
(~/eta-router untouched, not imported — pure functions extracted by AST); live DB read via Neon HTTP (string never printed);
every heavy command wrapped in a gate that blocks until last watchdog verdict is not STOP_* and diarize_ms < 400 (free_pct ignored, no cap).

## Wire shape vs fixture shape (the top finding)
Router source, `outcome` is written ONLY inside `segmentation` (router_server.py:588, 661, 772). No handler adds a top-level `outcome`
(/route :888, /route/job/{id} :921). Branch code reads TOP-LEVEL `outcome` (lib/stt/adapters/route.ts:99-103); the branch fixtures
(tests/unit/vad-starvation-job-path.test.ts jobReply) put `outcome` at top level.
Replies built with the router's REAL job_verdict (extracted, run per-window exactly as run_job assigns it), through routeAdapter.poll ->
buildRouteMetrics -> readEngineOutcome, and through writeRoutedRun into a real Postgres 16:

| case | row.route_outcome.outcome | engines_skipped | windows_total / skipped | route_transcribe silent_window (old rule chars===0 -> new) |
|---|---|---|---|---|
| partial 4 of 5 | null | false | 5 / 4 | false -> false |
| all 5 starved | null | true | 5 / 5 | false -> false |
| engine ran, no text (5 windows, 10 spans) | null | false | 5 / 0 | TRUE -> FALSE (regression) |
| zero sub-windows (run_job leaves status/segmentation None) | key ABSENT | reads unknown | - | true -> true (legacy fallback) |
| pre-change reply | key ABSENT | reads unknown | - | true -> true |
With a hand-built reply that has top-level outcome (the fixture shape): outcome "engine_no_text", silent_window true. So the branch
tests pass only on a shape the router never serves.

## Claims
1. Three states cold: HOLDS on skipped/known. no_engine {known:true, skipped:true}; engine_no_text {known:true, skipped:false};
   pre-change {known:false}, no `skipped` key. No fourth path to skipped (engines_skipped is set at one place, route-run.ts, from status/outcome).
2. Partial case: HOLDS through the real drain writer. Row: route_outcome {status ok, windows_total 5, windows_skipped 4, n_engine_segments 1, engines_skipped false}.
3. Emit-nothing rule: no spurious record from any empty shape (8 shapes probed -> {}). Widening (counts-only reply -> record) is real
   but UNTESTED: mutant M5 survives. Router never emits counts-only, so unreachable today.
4. Zero sub-windows: not mistaken for clean on the wire (status/segmentation stay None -> key absent -> unknown). But no code or test
   distinguishes "none of none" from "none to count"; a synthetic {windows_total:0, windows_skipped:0} with no status reads known/skipped:false.
   Unreachable with the current router.
5. Tests (each run gated on the watchdog): vad typecheck exit 0; typecheck:tests exit 0; route-metrics-truth.test.ts 14 passed / 0 failed; vad-starvation-job-path.test.ts 5 passed / 0 failed; FULL suite at 8d6b6e8 (npm test --no-file-parallelism) 134 files, 3077 passed / 0 failed / 1 skipped; FULL suite at 5bdffc0 133 files, 3072 passed / 0 failed / 1 skipped. All as claimed.

## Mutation (19 mutants; M20 was a comment-only no-op of mine and is excluded)
Killed 11: M1-M4 (windows_skipped/total dropped at writer or reader), M6 (spurious record), M8, M9 (either signal), M10 (partial over-claims skipped),
M11 (unknown read as known), M15, M16 (adapter drops segmentation/status).
Survived 8: M5 (widening reverted), M7 (skipped inferred from n_engine_segments===0), M12 (silent_window back to chars===0),
M13 (job result drops engines_skipped), M14 (drain write gate reverted: outcome never reaches the row), M17/M18/M19 (assembleTape engines mapping).
Real-Postgres and tape probes show the code for M14/M17-19 is CORRECT; the tests simply do not cover it (only the vad job-path test mentions route_outcome).

## Other
- Stale record through `extra`: top-level route_outcome IS re-derived, but the stale one survives nested at language_timeline.route_outcome
  (route-run.ts:84-89 comment claims otherwise). The test checks only the top level.
- Router process (pid started 19:45) is newer than router_server.py (mtime 13:49): job_verdict is loaded in the running router.
- No sql.unsafe / interactive transaction / Date object in the changed lib lines. No migration in either branch (0 db/ files). Live head 105.
- Live: transcription_run.metrics_json jsonb NOT NULL; 119 route rows, 0 with route_outcome, 119 with language_timeline. The existing rows stay
  UNKNOWN for ever; only rows written after the merge carry the discriminator.
- Merge: vad contains rmt (rmt is an ancestor). Against origin/main (293 commits behind) and origin/vinay/s1-auto-drain (cdb6f67): both orders
  0 conflicts, identical resulting trees.
- vad-starvation-job-path.test.ts docstring names vad-starvation.test.ts, which does not exist on this branch.

## Findings (ranked)
1. NON-BLOCKING for the rebuild, fix before more rows accrue: `route_outcome.outcome` is null on every row the drain will write. lib/stt/adapters/route.ts:99-103 reads a top-level `outcome`; the router nests it in `segmentation` (router_server.py:588/661/772). Effect: lib/jobs/kinds/route-transcribe.ts:192 gives silent_window:false for a window an engine heard and found quiet (old rule: true); engine_no_text is not separable from engine_text on the row. Fix: read `segmentation.outcome` as the fallback, and put a wire-shaped reply in the fixtures. The starvation list itself (engines_skipped, windows_skipped) is correct.
2. NON-BLOCKING: the row write (lib/stt/room-drain.ts:1106-1108) has no test; mutant M14 leaves 138 tests green. Same for the tape mapping (lib/room-day/admin.ts:531-536, mutants M17-M19): the "reading it cold" test never calls assembleTape (`void assembleTape`).
3. NON-BLOCKING: the widened emit-nothing rule (lib/stt/route-run.ts:163-166) is untested (M5); so is inference from n_engine_segments===0 (M7).
4. NON-BLOCKING: claim 4 has no code or test. A zero-sub-window job is not mistaken for clean today only because run_job leaves status/segmentation None, so the row reads unknown; a synthetic {windows_total:0, windows_skipped:0} reads known/skipped:false, and negative or skipped>total counts are accepted (route-run.ts:162-163).
5. NON-BLOCKING: the comment at route-run.ts:84-85 is wrong: a stale route_outcome passed through `extra` survives nested at language_timeline.route_outcome. The test checks only the top level.
6. NOTE: the 119 route rows already in the corpus carry no route_outcome and read UNKNOWN for ever; only rows written after the merge carry the discriminator, so the old windows must be re-run to be classified.
7. NOTE: tests/unit/vad-starvation-job-path.test.ts names vad-starvation.test.ts, which does not exist on the branch.

Evidence files (same folder family): scratch/ETA-RMT-VAD-probe-replies.test.ts.txt, ETA-RMT-VAD-probe-drain-pg.test.ts.txt, ETA-RMT-VAD-probe-tape.test.ts.txt, ETA-RMT-VAD-probe-stale-extra.test.ts.txt, ETA-RMT-VAD-mutation-harness.py.txt, ETA-RMT-VAD-router-replies-builder.py.txt.
Mini: no diarize run; the heavy commands (test suites, probes, mutants) each waited on the watchdog gate; it was GO throughout after the initial check.
