# Week A — round 3 (22 Sep ~21:00 IST) — from Fable

Standing rules from weekA-2140 apply. Docker now has more resources (V resized it); Postgres e2e is available again. Do not run two full suites at once: before a full vitest run, check `pgrep -fl vitest` and wait if another pane's suite is running.

## scribe3 — driver fix round 2 (Refuter FAIL, docs/handoff/ETA-OVERNIGHT-DRIVER-FIX-REFUTER-22-SEP-2026.md)
Same branch vinay/overnight-translate, new commit on top of 60b3072.
- F1: add `consecutiveForeignCancels` limit (default 5) → stop `fatal=foreign_cancels`; add a consecutive `join_contention_exhausted` limit (default 5) → stop `fatal=join_contention`. Any `done` resets both. Test both with the Refuter's two probes (cancel-everything, join-held-all-night) — each must now end fatal, not backlog_empty.
- F2: the maxFailedJobs exclusion counts ONLY this driver's own failures (actor = the driver's submitter id) AND excludes cancelled + join_already_running jobs. Pin the default (2) with a test. Report how many of the 143 parked windows become eligible again (read-only count).
- F3: make the recent-activity guard honest: keep it per-window (it prevents duplicate work) but rename/comment it as such; add a test that kills mutation RECENT_ACTIVITY_MINUTES 5→0. Do NOT try to solve the service-wide join mutex here.
- F4: fix the comment.
- Rebuild the staged bundle OVERLAID on current production s1-auto-drain@248c2ae code for everything outside lib/overnight-translate (so db.ts etc. are current). Report DONE with sha. Do not push until I say; do not start the driver.

## lx — after your segments suite finishes: router fix round 2 (Refuter FAIL, docs/handoff/ETA-ROUTER-STT-HYGIENE-REFUTER-22-SEP-2026.md)
Branch vinay/router-stt-hygiene in ~/eta-router, commit on top of d4cc9ca.
- F1 (clinical — dose swaps): segment dedupe drops a line ONLY if it is identical to the previous one after folding (case, punctuation, danda, whitespace). Remove the Jaccard rule. Tests: swapped-dose pair, morning/night pair, and "Yes."/"Yes." across two segments with different speakers or a gap >1.5 s must all be KEPT. Kill mutation R7.
- F2: exempt number words (English + Hindi/Kannada number words you can find in the existing guard lists) and digits from the within-line word-repeat collapse. Kill mutation R5 with a short-phrase test.
- Re-measure on the same 897 runs (counts only): how many pairs the strict rule collapses vs 2,186 target.
Report DONE with sha.

## scribe — before Refuter review of vinay/stt-hygiene (461433a)
1. Rerun the Postgres/e2e proofs now Docker is up (check no other suite is running first).
2. Your flag 5: add an env kill switch for the no_speech drop, `ETA_WHISPER_NOSPEECH_DROP` (default ON; `off` restores current behaviour). Test both states.
3. Confirm lib/ in the ETA repo has no Jaccard/word-set near-duplicate rule that could merge distinct lines (the router had one — see the router Refuter note F1). If it does, apply the identical-after-fold rule.
Report DONE with sha; I'll send it to the Refuter.

## ETA-Refuter
Hold. Next: scribe's stt-hygiene when I relay DONE, then scribe3 round 2, then lx round 2. Good catches on both.

## split-speaker — E-1/E-2 code, flag OFF
Worktree ~/dev/eta-wt-clock on vinay/encounter-clock off origin/vinay/s1-auto-drain. Build pure, tested modules (no routes, no migrations, no cron):
- lib/encounter-clock/probe.ts — probe scheduler over a room-day: picks probe instants (grid + level-log pre-selector when bench_level_sample exists), extracts on ORIGINAL CHUNKS with per-chunk sha256 + exact sample offsets (your finding), returns a contract object.
- lib/encounter-clock/gate.ts — E-2: energy half (level log or chunk RMS; dead-mic = zero_ratio≥0.98 or ≤−90 dBFS) + transcript half (your unique-chars/s definition, ≥0.15, provisional constant exported) → speech | non_speech | unjudged (missing evidence = unjudged, never silence).
- Tests incl. checksum round-trip on fixture audio. Flag `ENCOUNTER_CLOCK` default off, nothing wired. Report DONE with sha.

## yoga-drain — room-domain centroid candidate (E-3 / plan §D)
Your best-available run says the self-enrolment centroid is the wrong domain (c1304 0.093). Next, read-only, no writes to the voiceprint store:
- From rd_v7kw7x4d / bs_gkzmch9p (10 Sep Cardiology), take the turns scoring ≥0.70 vs the enrolment centroid as seeds (c1409, p1020 + any others). Build a room_primary candidate centroid from seeds only.
- Re-score ALL diarized turns of that day against it, leave-one-out for the seeds. Report the distribution (how many turns ≥0.70), c1304/c1409 values vs 0.735/0.842, and the top-3 clusters that are NOT the doctor (so we see separation). ≤12 lines + ~/dev/_fable/scratch/e3-roomcentroid.md. No transcript text.
