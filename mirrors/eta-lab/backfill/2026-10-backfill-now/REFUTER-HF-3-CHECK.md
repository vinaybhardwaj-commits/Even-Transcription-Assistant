# HF-3 check (HF-1 lane 3, 29 Sep) — eta-refuter-2, 8 Oct 2026 ~09:15 IST; backfill-lead #9468; report HF-3-REPORT.md 400e4f5f. Read-only, tests on my scratch copy.
VERDICT: PASS for install + the 5-window bench (steps 1-7). Conditions C1-C2 apply to the pull and to the full 418-window push.
Files: lane3_cpu_job 78bfd063 (pinned in run_lane3.sh da290e41), install_hf1 1c40e28b, collect_lane3 5ba8f15e, lane3_plan 317da009, test_lane3 b57db52b; 24/24 tests OK.
## Verified
- Blind, my own recompute with heldout.py (union f07171dc) over start / end-1s / ist_date:
  - files-2026-09-29.txt: 418/418 in the manifest, 0 blind;
  - bench list: 5/5, 0 blind;
  - the 29 Sep manifest itself has 0 blind.
  The job checks blind before opening audio; its embedded blind-list sha 56f5999c = lane 1's.
- Audio: all 418 plan windows carry a 64-hex audio_sha256, and the job refuses a mismatch before decoding. NOTE: the check is skipped when a window has no sha; that is fine for this plan, but make it refuse in a later edit.
- Remote code:
  - snapshot dir == pinned 40-hex revision, and every pinned code/config file is sha-checked BEFORE trust_remote_code;
  - the indic model's own unpinned snapshot_download is forced to the pinned revision during from_pretrained;
  - pinned commits are immutable on HF, so files not on the pin list are fixed by the revision too.
  - Limit (declared): weights are not hash-pinned.
- Identity (per the report and the tests): lane = existing config + producer {hf1-cpu-torch-fp32, device cpu, revision, code sha, fp32}, version hf1-cpu-lane3-1. The job refuses lane == existing and checks that strip-back gives the existing hash; the collector rejects existing-product hashes. So HF-1 output cannot block or masquerade as the c3/c4/box indic and SraVaani tracks.
- Pins: run_lane3.sh refuses if the job sha16 != 78bfd063; the job re-checks its own sha, the heldout constant and the blind-list sha. The token is read from a 0600 file only, never argv.
## Conditions
- C1 (step 8): do not pull outputs (transcripts) to /tmp/l3pull. Use a 0700 dir under ~/eta-data (e.g. ~/eta-data/hist/hf3-pull/<ts>), and point collect_lane3 --src there.
- C2 (Mini clinic-hours ban, 07:30-21:30): the audio path B goes box -> Mini -> Space. The 5-window bench (tens of MB, one tar stream) is a light hop and OK.
  The FULL 418-window push (1.33 GB) through the Mini must run after 21:30 or before 07:30, or by another route (e.g. box -> Space directly if a key is added there). Same for any bulk pull.
## Notes, not blocking
- Plan rule: commit to the full day only if the bench gives >= 6 windows/h on HF-1's 8 vCPU. The report's ~7/h was measured on the loaded box, so it is not HF-1's number yet.
- UNVERIFIED by the builder and by me: install_hf1.sh as a whole on HF-1, and whether gated-model access works with V's read-only token. The bench shows both.
## HF-3b addendum (09:40; report section sha 99603c7e; job ab5cef4f, install ff454483, run_lane3 e38cb8a4, stage_snapshots 5ca4466f, stage_pins 6358ed60, test f912ec0c)
VERDICT HF-3 + HF-3b: PASS for the snapshot staging, offline install and 5-window bench. C1 and C2 still apply, and C2 now covers the 3.47 GB snapshot stream too. One should-fix (H1).
- 30/30 tests OK on my scratch copy. The job diff vs .bak-hf3b only adds offline_mode / snapshot_path / verify_manifest and uses offline_mode().
- verify_manifest: the snapshot must have exactly the manifest's file set, every file sha-checked (extra or missing => refuse). With it the WEIGHTS are now integrity-checked too: the old "weights unpinned" limit is closed at install.
- stage_snapshots.sh:
  - verifies on the box (revision dir, code pins, every file vs the c4 measurement) before streaming;
  - streams only the two pinned snapshot trees (dereferenced) + lane3-pins;
  - no blobs/refs, token or audio; diagnostics on stderr.
- install_hf1.sh exits INSTALL-OK on the offline path before any token code; run_lane3.sh exports HF_HUB_OFFLINE=1 when both snapshots exist.
- H1 (should-fix): the full-file manifest (lane3-pins/pinned_snapshots.json, sha16 09dfb9c1 on the box) travels IN the same stream and nothing on HF-1 pins its sha. A corrupted stream that also carried a changed manifest would self-verify its weights. Code files stay safe (CODE_PINS are constants in the job).
  Fix: pin the manifest sha256 as a constant in install_hf1.sh (or the job) and check it before use.
- C2 (extended): the 3.47 GB snapshot tar and the 1.33 GB full audio go through the Mini, so both run only outside 07:30-21:30. The 5-window bench audio alone is fine any time.
- Note for herdr-lead: both models are GATED (auto-approval licence). Copying the snapshots into our own private Space under the same account is presumably within the accepted terms, but that is a licence question, not mine to rule.
