# rl-stt-oref3: Opus 5.5 re-refute of rl_stt.py 6579876b (r2 4d2d15f0 -> r3)
Verdict: **FAIL**. Scope and gates are fine; FAILURES.jsonl privacy fails the stated check. Fake gateway only, no Sarvam or network call, no GO file, ft/* untouched (work in /tmp/rloref3). r3 rl_stt.py, wait_b, wait_c and test_rl_stt.py are byte-identical to ft/. run_a.sh is unchanged.
## (1) Diff scope: PASS
- rl_stt.py has 4 hunks: `import traceback`; a new `fail_log=None` kwarg on run_jobs; a try/except-pass block inside the existing `except` that appends one JSON line; main passes out/<lane>/FAILURES.jsonl.
  The block runs only after a failure. It does no send, and it changes no budget, refund, attempts, ledger, retry, cap, GO or gate logic. Its own errors are swallowed.
- wait_b and wait_c: `--workers "${WORKERS:-2}"` (it was the CLI default of 4). Budget.reserve runs per job under a lock, so the worker count does not change the cap.
  Note: WORKERS from the environment is not bounded, but r2 already accepted any --workers value.
- test_rl_stt.py adds 1 test (class, status, where, URL masked, 0600).
## (2) FAILURES.jsonl privacy: FAIL
- The file is 0600 when it is created (O_CREAT 0o600, no fchmod, so a file that already exists keeps its mode). But it is NOT in a 0700 dir.
  The lane dir comes from `os.makedirs(lane_dir, exist_ok=True)` with no mode. With umask 0002 that gives 0775, and the live out/ft-rl-stt-{a,b,c} dirs are 0755 now.
- The mask covers URLs only. Probe /tmp/oref3/mask.py: a fake exception message carrying `api-subscription-key=sk_FAKE…`, `Bearer eyJ…`, a 10-digit number and free text.
  The URL query was masked. The key, the bearer token, the 10-digit number and the free text were all written verbatim (twice: first try plus the retry).
  Real GatewayError strings include up to 200 chars of the error body (sarvam_lane.py:312). FAILED.tsv in r2 already stores the same str(e)[:140], so the risk is not new, but the claimed masking does not hold.
- Fix: chmod the lane dir to 0700 (or write to a 0700 subdir), and fchmod the file to 0600. Extend the mask to runs of 7+ digits, `Bearer \S+`, `(key|token|sig|secret|password)\S*[=:]\s*\S+` and 20+ char [A-Za-z0-9_.-] runs. Apply the same mask to the FAILED.tsv reason, and add the probe above as a test.
## (3) Tests and F1: PASS
- On the /tmp copy, test_rl_stt.py passes 54/54 and test_rl_stt_oref.py passes 44/44.
- F1 'GO 1 4' x3 (4-min call, job fails after it is created): run 1 makes 1 send (4.0 min billed), runs 2 and 3 are REFUSED by check_go. Total 4.0 <= 4.2. The attempt and lane-lock probes also pass (3/3).
