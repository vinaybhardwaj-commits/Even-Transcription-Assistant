# ETA MASTER STATE — 16 Sep 2026, 06:00 IST · Fable

Supersedes ETA-MASTER-STATE-AND-SPINUP-15-SEP-2026.md. Single entry point. Read §1 and §2
before touching anything.

## 1. THE FACT THAT CHANGES EVERYTHING (measured, ETA-E26)

**Production runs `fe021a30` from branch `vinay/s1-auto-drain`. It does NOT run `main`.**
`origin/main` is `7ffb168`, 25 Aug 2026 — stale, no diarize job, not a release channel.
There is no `.vercel/project.json`; nothing in the repo reveals this.

**The branch IS the release channel.** No gate sits between `vinay/s1-auto-drain` and
production. Feature work lands there as PREVIEW builds (`target: null`) until promoted.
"Merged to main" is meaningless in this repo and must never appear in a ruling.

## 2. STOP CONDITIONS — read before any deploy

- **R19: do NOT promote `vinay/s1-auto-drain` to production until the F1 fix is refuted.**
  E17 as it stands at `3aa75c9` hands a refused room 98-100 of 117 slots (measured).
  The fix is `836188f`; it has never been refuted. That refutation is the critical path.
- **R16/R20: 0099 AND 0097 must be applied BEFORE E24 code deploys.** Reversed, every
  diarize INSERT and every emotion `prepare` SELECT fails on a missing column. The
  constraint binds at the MERGE into `vinay/s1-auto-drain`, not on the e16 branch.
- Migration 0100 is a plain `CREATE INDEX IF NOT EXISTS` — the runner's transaction
  forbids CONCURRENTLY. Its live post-apply EXPLAIN is owed at apply time (R22).

## 3. SECURITY — outstanding, owner V

Two credential VALUES were printed into Claude Code transcripts by `pgrep -fl`, confirmed
independently by two panes: **`GROQ_API_KEY`** (Refuter transcript) and
**`CLAUDE_CODE_MESSAGING_TOKEN`** (scribe3 transcript). Both need rotation. Neither value
passed through the orchestrator and neither is in any report or commit message.
Standing rule (testing rule 22b): never `pgrep -fl`, `ps auxe`, `ps -E`, or
`/proc/*/environ`. `pgrep` for pids, `pgrep -l` for names.

## 4. BRANCHES AND WORKTREES

| worktree | branch | HEAD | state |
|---|---|---|---|
| main | `vinay/s1-auto-drain` | `836188f` + R11 round in flight | production channel. E17 + E11(e)(f) + F1 fix. UNREFUTED |
| `-e16` | `vinay/e16-emotion-speech-fraction` | `cb35001` | E16 + E24 fix round 2. Refuted twice, fixed twice. Not yet re-refuted |
| `-e20` | `vinay/e20-losing-score` | `c041ea8` | clean, unrefuted |
| `-slice-e` | `vinay/tier2-e` | `fee5822` | untouched |

Migrations: 0097 (E16, committed, NOT applied) · 0099 (E24 run-id + stale mark, committed,
NOT applied) · 0100 (E22 partial index, committed, NOT applied). 0094/0095/0096/0098 as
previously recorded.

## 5. THE TWO COUNTS — measured 16 Sep 06:07

- **F2 backlog: 0.** No existing `ok` diarize row with NULL `segments_run_id` and an
  unscored or retryable emotion row. Nothing goes stale on its next offer today.
- **`no_speakers` rows: 3.** K1's entire historical reach.

**RULING R18 — NO BACKFILL.** The backlog is zero, so there is nothing to backfill. The
only NULL `segments_run_id` rows that can ever exist are deploy-straddle rows: written by
pre-E24 code in the gap between applying 0099 and deploying E24. R17's honest reason text
("the writer is unrecorded", never "predates 0099") is correct for exactly those rows and
is now doing all the work. Keep the straddle short by applying 0099 and deploying E24
close together, and state the straddle in ETA-E25.

**RULING R24 — K1's fix is proportionate.** Three `no_speakers` rows exist in total. R13
(the repair may only adopt content from a run that itself ended `ok`) costs us at most
three historical windows and removes a provenance lie from the `state` column. Confirmed.

## 6. RULINGS INDEX (R0-R24)

R0 main gets c041ea8 · R1.1-R1.3 silence must be named, evidenced, bulk-re-adjudicable
(E18) · R2-R4 F1 blocks merge, mark served on OFFER, fix now not later · R5 F2/F6 tests ·
R6 F3 folds into E19 · R7 F5-live withdrawn as standalone (see §8) · R8 stale spends no
attempt · R9 record the diarize run id, provenance is a fact · R10 do NOT change the
keep-rule at `diarize-window.ts:289` · R11 add the partial index · R12 name the test that
is the proof · R13 repair adopts only an ok run · R14 repair replaces `speakers_json` ·
R15 narrow the stale bypass to the repair · R16 0099 before deploy, in three places ·
R17 the reason text must not assert a cause the data cannot support · R18 no backfill ·
R19 no promotion until F1 is refuted · R20 ordering binds at the merge · R21 stop treating
`main` as meaningful · R22 the owed measurement goes in the apply record · R23 swift test
crash: rerun once, then name it failing · R24 K1's fix is proportionate.

Bus documents: ETA-E22 (rulings on the E11/E17 refutation), ETA-E24 (rulings on the E16
refutation), ETA-E25 (deploy order), ETA-E26 (what production actually runs), plus the
refutation reports for E11/E17, E16, E16-fix, and the F5 debug.

## 7. WHAT IS TRUE ABOUT THE CODE THAT WAS NOT TRUE YESTERDAY

- **Nothing in this codebase is atomic.** The Neon HTTP driver commits every statement on
  its own, so one job step is N+2 separate commits (N+3 under E24). `sql.transaction()`
  is present in the installed 0.10.4 and **no server code uses it**. This is an
  architectural finding and it earns its own round.
- The pipeline completed end to end for the first time at 20:16:32 on 14 Sep.
- A span that clears the amplitude gate was being scored as if it were all speech; A9 got
  one label across 29 s that were 92 % silence. E16 records the speech fraction. There is
  no fraction cutoff, by design (Option A: measure and record, do not gate).
- `recordDiarizeWindow` KEEPS an `ok` row's `segments_json` while `last_run_id` advances
  (`diarize-window.ts:285/289`). That is the stale-segments hazard, now named and guarded.

## 8. OPEN, RANKED

1. **Refute `836188f`** — F1 fix. Blocks R19, blocks production. Critical path.
2. **Re-refute `cb35001`** — E16 fix round 2 (K1, K2, F4, R17, N12).
3. Refute the R11 index round once scribe3 commits it.
4. **The atomicity round** — option 1 from the F5 debug: collapse the turn writes and the
   window record into one atomic write. Cuts ~317 round trips. Not a bolt-on.
5. **F5 itself — RULING: take option 3, detect rather than prevent.** Run the §3 query
   before scoring and record a named state. No migration; a successful retry already heals
   the condition. Option 1 supersedes it if item 4 happens first.
6. E18 carrying R1.1-R1.3 · E19 carrying R6 and the withdrawn F5-live consistency item ·
   E21 native recorder audio levels · E13 (dead mic vs quiet room) · E15 (VAD calibration).
7. The 1,442-window backlog; `stt_subject_job`'s 229 queued `asr` rows; run identity for
   diarize; the three-way speech-signal disagreement (up to 125x); Whisper's turn-bound
   timestamp mapping; the two unversioned service contracts.

## 9. A SECOND WORKSTREAM IS LIVE IN THIS REPO

Cursor Agent, PRs #2 and #3, branches `cursor/scribe-fleet-rca-15sep-6a9c` (37dc020) and
`cursor/piece-pipeline-pipe-close-6a9c` (0803d51): Home Office EMFILE, ~4847 leaked PIPEs
against `ulimit -n 256`, `MachineFacts.runTool` never closing Pipe handles across three
calls per 1.5 s poll, `room-recorder.lock` held by a leaked pid since 12 Sep, Room 4.1
tapewriter failures, OPD 3 digital silence. PREVIEW only, no production target, no
collision with our branches. **Whoever closes E13 must read those two branches first** —
the OPD 3 digital-silence work sits directly on top of it.

## 10. HOW THE LOOP IS RUNNING

Three panes: `scribe` and `scribe3` (Sonnet, Builder/Researcher), `ETA-Refuter` (Opus,
Refuter/Debugger). Fable orchestrates only. Clear a pane at a report boundary — the bus is
the memory, the pane's context is scratch.

Testing rules now number **22** (see the standing rules file). Rules 18, 19 and 21 are one
family and must be checked together: a fake can be wrong about the SHAPE of the data; a
guard that enumerates cannot see what it was not told about; and a simulation is a guard,
so the refusal, the timeout and the off-by-one must be IN the model or it is the happy
path in a costume. Three consecutive rounds on 15 Sep produced survivors visible only with
realistic inputs.

**The loop's own record this session: agents corrected the orchestrator on the commit
message twice, on the E16 severity once, on the EXPLAIN instruction once, and on the
production topology once — that last one from a footnote in a report about something
else.** A brief is a claim, not a fact. Keep building the loop that way.
