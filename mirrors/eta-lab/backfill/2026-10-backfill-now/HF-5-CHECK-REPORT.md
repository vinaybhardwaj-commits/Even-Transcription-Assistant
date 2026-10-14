# HF-5 check: lane-1 all on HF, driver (eta-refuter-2, 8 Oct 2026 ~13:45 IST; backfill-lead #9698; ORDERS-HF-5 4f4b4420, HF-5-REPORT 8134ce7e). Read-only; tests and probes on my scratch copy.
VERDICT: PASS-WITH-CONDITIONS. The 2 pilot-size jobs are fine as launched. Lift the pilot cap (write drive/HF1C-PASS) only after C1-C2; C3 before any --apply-collect.
Files: drive_lane1 fdfc1b3a, test_drive_lane1 3f70a9c0; imports unchanged: launch_lane 12a2ed1e (HF-1c, PASSed #9466), collect_lane 339f7a83, job 3bec47c9, hf_budget e1264a7a.
## Verified
1. Tests: 31/31 driver tests and 43/43 lane-1 tests pass on my scratch copy (system python3).
2. Scope, my own recompute: 6,306 windows (6,256 HF-4 worklist + 50 from the 28 Sep pilot), 5 collision ids excluded, 31 days, 0 blind (heldout.py union f07171dc), every window has a 64-hex audio sha. Day order starts 12 Sep, 26 Sep, 19 Sep, 28 Sep.
3. Live pre-PASS run (13:22, --max-ticks 3, now exited):
   - pushed 21 audio files for 12 Sep: 21 verified, 0 failed, 0 local-sha mismatch;
   - launched 2 jobs (6ac74c4a, 6ac74c58), 15 windows each: 45/45 claims each record that job's id, 0 overlap, 0 blind, all in scope;
   - then held at concurrency 2/2. The pilot cap held.
4. Money gate (code + tests):
   - Lane $70/day = lane jobs created today (IST) + every open lane job counted at the full 45-min timeout + the new job.
   - Account $80/day, lane total $220 (job-list durations), balance floor $5 = balance.json minus usage-v2 billed since asof, minus committed, minus the new job.
   - A missing balance file or unreadable billing fails closed (exception, before any claim).
   - Day reset is at IST midnight; a "today" hold re-checks every ~10 min.
5. Concurrency starts at 2, goes +1 per COMPLETED and -1 per ERROR (never below 2), max 6. 3 consecutive failures write PAUSE. STOP and PAUSE are honoured.
6. Claims: all-or-nothing O_EXCL per window. Unconditional releases (lost race, launch failed) touch only claims this pass just created. Reconcile goes through HF-1c release(job_id=jid), so an old job never releases a newer job's claim (G1; tested).
7. Audio push:
   - only windows that plan() kept, so blind and ignore-list windows are never pushed;
   - local sha checked against the worklist before upload; upload, download back, sha again;
   - box -> HF directly via the hf CLI, not via the Mini;
   - new buckets are created --private.
8. Collect: pulls go to a 0700 dir under ~/eta-data/hist/hf1-pull. The screen checks machine hf-job, script sha 3bec47c9, stub audio sha == the worklist sha, and that the window is in scope. collect_lane then re-refuses blind windows and is write-once.
9. Torch pin: `--with` exists in `hf jobs uv run`; the job file and its sha are unchanged.
## Conditions
- C1 (before lifting the pilot cap): one driver at a time.
  - There is no lock, and state.json uses a fixed ".tmp" name. A second driver (or a restart while one is still running) overwrites the other's job records.
  - Effect: those jobs' claims are never reconciled (windows stuck), the pilot-cap count resets, and the concurrency doubles.
  - Fix: take an exclusive flock on drive/LOCK at startup and exit if it is held.
- C2 (before lifting the pilot cap): a loop without --apply-collect pulls again on every tick.
  - In dry-run collect mode `collected` is never set, so every finished day is synced again every poll (60 s) into a new timestamped dir: endless transcript copies.
  - Fix: record a dry-run per day once (e.g. days[d]["dry_ok"]), or refuse --run without --apply-collect once the cap is lifted.
- C3 (before any --apply-collect): apply is NOT gated on drive/HF1C-PASS in code (only the flag). Gate it on pass_ok(), as the brief says.
## Should-fix (not blocking)
- S1, budget race: committed comes only from HF's job listing. My probe P1, with a listing that does not show the just-launched jobs, launched 3 jobs on 69.00 lane-today, i.e. 70.80 > 70. Fix: committed_lane = max(listing, the driver's own open jobs × 0.60).
- S2, early "complete": a day is marked complete when every remaining window is claimed by someone else (probe P2: all claims foreign => "done", complete=True). Such windows (stale or orphan claims) are then never revisited. Fix: require claimed_only == 0 (plan stats) as well.
- S3, crash or parse failures around launch:
  - a crash between `hf jobs` returning and set_claim_job/save leaves orphan claims with job None;
  - a job-id regex miss on a job that actually started releases its claims, so the next tick relaunches the same windows (duplicate cost; write-once protects the data).
  - Fix: on a parse miss, keep the claims and write PAUSE.
- S4, bad upload: a failed round-trip leaves the object in the audio bucket, so the next plan treats that audio as present. The screen catches it at collect (audio_sha_mismatch), but the window then stays undone. Fix: record the name and exclude it, or PAUSE.
## Notes
- Torch: inferring 2.14.1 from the pilot's wheel size plus "newest on PyPI at launch" is plausible but not proof, and the job does not record the torch version.
  - A better source than wheel size: one small job, pinned, on 3 windows the pilot already wrote, into a SCRATCH out bucket that is never collected; compare seg/text sha with the pilot outputs. Cost about $0.2.
  - At risk: only the 35 pilot windows already collected. All new windows share the pin.
- Balance gate: usage-v2 lag (F5) means a job that just finished is neither committed nor billed yet. With 6 in flight that is a few dollars against the $5 floor.
  - The lane caps use job durations and are not affected.
  - After V's top-up, write balance.json with the asof of the reading itself (never later).
- Day attribution: a job created before midnight counts fully to the earlier day. Overshoot of calendar billing is at most one batch of committed jobs.
- Timeout: 15 × ~141 s + load ≈ 39-40 of 45 min. The 2 live jobs measure this. A timeout keeps the windows already written but counts toward the breaker.
- Money: est. $213-226 vs the $220 cap, so the driver may stop ~150 windows short. That is a ruling for V.
- state.json and claim writes are not fsynced (power-loss risk only).
## HF-5b re-check (8 Oct ~14:30 IST; backfill-lead #9757; ORDERS-HF-5b bb6736f6)
VERDICT: PASS. C1-C3 and S1-S3 are fixed. The pilot cap may be lifted (HF1C-PASS) and `--run --apply-collect` started.
Files: drive_lane1 cd853667 (= c1cc4b5a + windows 12), test_drive_lane1 25e77dc6; the backups .bak-hf5b = fdfc1b3a (what I checked first) and .bak-windows12 = c1cc4b5a. Imports unchanged: launch_lane 12a2ed1e, collect_lane 339f7a83, job 3bec47c9, hf_budget e1264a7a. I read the full diff against fdfc1b3a: it contains only the fixes below.
- Tests on my scratch copy: 39/39 driver, 43/43 lane-1. My own probes:
  - C1: a second process gets "REFUSED" (rc 1) while the flock is held. The lock is taken before load_state. The state tmp file is now per pid.
  - C2: one dry pull per day (dry_ok). With HF1C-PASS present, --run needs --apply-collect or --no-collect.
  - C3: refused at startup, and collect_day(apply=True) without PASS refuses before any pull dir is made.
  - S1: my P1 probe (listing lags, 69.00 today) now launches 1 job, not 3. committed = max(listing, own open jobs × 0.60).
  - S2: my P2 probe (all claims foreign) gives "idle" and the day is not complete.
  - S3: LaunchUnknown keeps all claims and writes PAUSE, and the next tick holds. A "launched_raw" ledger line is written before tagging; a crash while tagging writes PAUSE.
- windows_per_job 12: the pilot took 38.6-42.4 min per 15 windows, so 12 windows is about 31-34 min against the 45-min timeout. usd_per_window 0.038 only feeds the projection; the gate still commits $0.60 per job.
## Notes (not blocking)
- The lock covers drive_lane1 only. Do not run `launch_lane.py --launch` or `--reconcile` by hand while the driver runs.
- A small window remains: tagged claims plus a crash before save_state means the job is missing from state.json. launched_raw in the ledger is the record to recover it from.
- If a pull fails, every tick makes an empty pull dir; clean these up at the end (move to _to_delete).
- S4 is still open: a failed round-trip upload leaves the bad object in the bucket. The collect screen catches it as audio_sha_mismatch; watch the ledger for push_audio failed > 0.
- Torch proof (3 pilot-done windows into a scratch bucket) and the $220-vs-estimate ruling: unchanged from above.
