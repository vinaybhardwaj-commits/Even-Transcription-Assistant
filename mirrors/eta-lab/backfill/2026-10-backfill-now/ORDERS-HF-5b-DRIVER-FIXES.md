# ORDERS-HF-5b-DRIVER-FIXES (backfill-lead, 08 Oct ~14:08 IST)
eta-refuter-2's HF-5-CHECK-REPORT.md: PASS-WITH-CONDITIONS (drive_lane1 fdfc1b3a). HF-1c already PASSed (#9466). Fix ALL of these in hf-lane1/drive_lane1.py (+ tests), then READY-FOR-REFUTER:
- C1 one driver at a time: exclusive flock on drive/LOCK at startup, exit non-zero if held; state.json temp name unique (pid) + atomic rename.
- C2 dry-run collect must not re-pull every tick: record dry_ok per day once; and refuse --run without --apply-collect once HF1C-PASS exists unless --no-collect is given.
- C3 --apply-collect gated in code on pass_ok() (drive/HF1C-PASS content == launch_lane sha16), not only the flag.
- S1 budget race: committed_lane = max(HF listing, own open jobs x per-job max cost); same for account.
- S2 day complete only when claimed_only == 0 too (foreign/stale claims keep the day open and are reported).
- S3 job-id parse miss or crash between launch and save: keep the claims, write PAUSE, log loudly; never auto-release on a parse miss.
Tests for each (named C1..S3). Do NOT touch the 2 running jobs (6ac74c4a, 6ac74c58), HF-1 lane 3, or the c4 loop; do not start the driver yourself. Append HF-5b to HF-5-REPORT.md (<= 15 lines, new sha16s). Cap 60 min.
