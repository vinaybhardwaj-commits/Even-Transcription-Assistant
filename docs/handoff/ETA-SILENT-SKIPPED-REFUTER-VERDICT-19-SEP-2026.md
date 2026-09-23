# Refutation: ~/eta-router working-tree fix (HEAD 564eb41 + 61/-7 lines) + test_job_verdict.py
Verdict: SOUND WITH FINDINGS. Restart safe now: YES (precheck: RESTART SAFE; live pid 57265 up since 13:10 running HEAD).
Router edits are inert until restart: file mtime 13:49 > process start 13:10. Working tree not edited by me (mutants ran on /tmp copies).

## Reproductions (HEAD = live vs working tree), real transcribe_norm_wav / run_job, engines stubbed, no network
R1 original 60 s half-silence/half-noise, Silero empty, engines ran + found nothing: HEAD silent_skipped (2 engine calls) -> tree ok / engine_no_text / n_engine_segments 2.
R2 genuinely silent 30 s: silent_skipped / no_engine / 0 engine calls, both with Silero stubbed empty and REAL Silero.
run_job: silent -> silent_skipped/no_engine; ran_found_nothing (my earlier case) -> ok/engine_no_text, windows_skipped 1 of 2 kept; all-ran-nothing -> ok/engine_no_text; partial_text -> ok/engine_text; zero_frames -> silent_skipped/no_engine (ffmpeg yields 1 window).
Subset property: every window the tree calls silent_skipped, HEAD also called silent_skipped (seg_jobs empty implies n_skipped_silent > 0 whenever spans exist), so the fix cannot add a skip.
Sites that emit silent_skipped: :597 (dead branch: vad_segments/plan_segments never return no spans), :654, :764. No fourth.

## Findings
1 NON-BLOCKING test gap: reverting :654 (the line that had the bug) leaves 9/9 green (M1). Also survive: single-window status always "ok" (M7), :661 outcome hard-coded (M8), run_job wiring :828 removed (M9), (a)-branch n_engine_segments dropped (M10). test_b_..._THE_BUG passes on the OLD job rule (its win() helper sets status ok when an engine ran, so windows_skipped=0): only test_repro_multiwindow (+ test_empty_job) kills M2. win() builds status with engine_ran(), the helper under test.
2 NON-BLOCKING naming: engine FAILURE is (b). process_segment swallows every engine error (:431, :456, :476 + sravaani thread) so all engines raising -> ok / engine_no_text / n_engine_segments 2 (R3). HEAD also said ok, so not a regression, but "the audio WAS heard" (docstring :534-540) is false there.
3 NON-BLOCKING (c) can hold zero chars: :661 counts len(segments), and :627 keeps low_confidence entries whose text is "" (process_segment refused-hallucination return). Whisper loop refused -> 2 output segments, 0 chars, outcome engine_text (R4). Text-bearing count would separate (b)/(c).
4 Threshold NOT moved: :76 = 0.5, :273 passes it, silero_vad 6.2.1 default 0.5, no changed diff line mentions it, plist (unchanged since 16 Jun) has only ETA_DEFAULT_CANDIDATES/ETA_MAX_INFLIGHT/PATH. Not blocking.
5 job_verdict([]) is now silent_skipped (was ok); unreachable in run_job (called after append). Pinned by test_empty_job. Not a finding.

## Restart (unchanged from last pass)
Cost: daemon run_job threads die, files stay `running`, app polls them as still_running with no stall detection until a later POST /route/job's _cleanup_old_jobs (TTL 3600 s) 404s them; a stranded window sits transcribing >= 1 h. Downtime itself: polls retried, a submit in the gap burns 1 of 3 attempts. Precheck: /Users/vinaybhardwaj/dev/scratch/router-restart-precheck.sh -> RESTART SAFE. File imports cleanly (app = FastAPI).

## Cheap way to make the discriminator survive to the row (app, not touched)
Router now emits segmentation.outcome + n_engine_segments at window and job level. App EngineRunRecord (vinay/vad-starvation c33148d) keeps status/segmentation_method/windows_*, not those two: copy segmentation.outcome and n_engine_segments in buildEngineRunMetrics (and the adapter must pass segmentation through, as c33148d does).

## Evidence: refute-router-exp2.py/.out, refute-gen-jobs2.py, vad-jobs2/*.json, refute-mutants.py (run on /tmp copies)
