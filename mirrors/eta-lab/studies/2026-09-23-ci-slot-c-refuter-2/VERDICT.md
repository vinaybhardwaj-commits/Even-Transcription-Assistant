# CI slot C (eta-ci-c3) in the auto-pick order — Refuter verdict (eta-refuter-2, 23 Sep 2026)

Under review: `yoga-test.sh` slot C (dd9a78e, herdr-kit). ETA-Refuter's kit verdict (ledger 459) covered the
two-slot picker. Slot C was added after it. Not built by this session. Only read-only ssh was used on c3.

**VERDICT: FAIL. Take slot C out of the auto-pick order until it can run Docker.** It fails safe (never
green), but any gate that lands there is a guaranteed false FAIL, and the commit misreports the evidence.

## Evidence (c3, read-only)
- `command -v docker` on c3: nothing. Docker is not installed.
- c3's own log `~/eta-ci/logs/20260923T145553Z-d519d7b-*.log` (949 lines) is the run the commit cites as
  "Verified live: a full gate on d519d7b ran on c3 in ~77s". It ends
  **`Test Files 20 failed | 170 passed (190)` · `Tests 20 failed | 3985 passed | 260 skipped` ·
  `RESULT test_failed`**. All 20 failures are "REQUIRED PROOF NOT RUN … needs Docker for postgres:16".
- So the proofs did not "skip entirely" as the commit says. The guards made them FAIL, as designed.
  d519d7b is a commit that passes on the box and on GitHub (my run 35884778798).

## Why it matters
- A plain full-suite call goes to C whenever A and B are both busy, which is exactly the busy-night case,
  and C returns test_failed for ANY commit. A builder reads that as their own failure. The tempting "fix",
  `ETA_ALLOW_SKIP_E2E=1`, would turn a false FAIL into a false PASS that proves nothing about the SQL.
- The commit text treats a failed run as a verification. That is the "report UNVERIFIED as UNVERIFIED"
  rule the other way round.

## Fix
Remove C from the picker (keep it reachable only with an explicit `CI_HOST=`) until DOCKER-TO-E2E lands there.
Better, and permanent: make `host_is_free` require the gate's real preconditions, i.e.
`docker run --rm postgres:16 true` succeeds on that host, so any slot missing Docker is never auto-picked.
This also fits ETA-Refuter's three-state fix for `host_is_free` (free / busy / unusable).
