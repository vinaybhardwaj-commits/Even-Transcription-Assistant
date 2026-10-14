# HF-3c check: HF-1 lane 3 from local disk (eta-refuter-2, 8 Oct 2026 ~12:50 IST; backfill-lead #9632; ORDERS-HF-3c 552462dd). Read-only; tests on my scratch copy.
VERDICT: PASS for the staging/run scripts. Separately, by the plan's own rule (#9447/#9451: commit only at >= 6 windows/h) the measured 4.9 windows/h does NOT qualify the 29 Sep day run. That decision is herdr-lead's/backfill-lead's, not a script fault.
Files: stage_local.sh dbf42f94, stage_local.py e542ddc7, run_lane3.sh 70357ea3, install_hf1.sh 6b6c0680, test_stage_local 6b27fbb7; job lane3_cpu_job.py = ab5cef4f (unchanged, confirmed).
## Verified
1. Tests: test_lane3 30/30 and test_stage_local 6/6 OK on my scratch copy.
2. READY marker: run_lane3.sh refuses (exit 3, no run.pid) unless marker-check passes: marker self-hash, root, job sha16 == the pin, local job file sha, staged files present with their sizes.
   - The marker checks sizes, not contents, of the staged hf_home/venvs. Acceptable: the hf_home snapshots are byte-verified by install_hf1.sh's offline check during staging, and the job re-checks its own sha.
3. No-overwrite mirror: copy_atomic uses tmp + fsync + os.link, so an existing dst is never replaced; a differing existing file is kept and counted (tested). Resume skips done windows, ignores tmp files and copies logs atomically.
4. Staging byte-verify: audio is copied tmp + rename and sha256-checked against the window list (mismatch => .bad-<ts>, non-zero exit). Snapshots: the full offline manifest verify (indic 404, sravaani 11) runs inside staging.
5. Nothing deleted on /data: stage_local.sh / .py / run_lane3.sh only read /data or link new files into /data/lane3/out and work. The only mv is of LOCAL scratch dirs (renamed ._old-<pid>, not deleted). No rm/rmtree on /data in any of the three.
6. The job is unchanged, so blind-before-open, audio sha refusal and write-once all still hold.
## Notes
- Rate (builder, limit-1 on HF-1): indic 694 s + SraVaani 39 s = 733 s per 900 s window = 4.9 windows/h, so 418 windows ~ 85 h. The 5-window median is still pending, but at ~12 min/window it will not reach 6/h unless a window is far shorter. Compare HF-4 (E2E GPU lane) for this day.
- Local disk is ephemeral and holds patient audio under /tmp/lane3-local on HF-1. It goes away on a Space restart/pause; do not leave it staged beyond the run.
- Still open from #9590: which route the 3.47 GB snapshot stream took at ~10:08-10:50 (Mini clinic hours, C2). HF-3c itself states no Mini traffic.
