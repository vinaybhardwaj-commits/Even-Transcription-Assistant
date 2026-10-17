# BC-SENTINEL-S0-BUILD

Lane bc-s0, branch bc/sentinel-s0 (base origin/main bffc52f7), 17 Oct 2026.

## What changed
- Kiosk copied from origin/cloudpane/cloud-guardian-r16e/r16e (tip a769f4d2, version c1-0.4.8-r16e): `git checkout <ref> -- tools/room-guardian/kiosk`. 29 files (17 modified, 12 new test files), all inside kiosk/. Verified byte-identical to the source ref: `git diff --cached origin/cloudpane/cloud-guardian-r16e/r16e -- tools/room-guardian/kiosk` is empty.
- tools/room-guardian/mini and all of main's other paths: untouched (0 staged files outside kiosk/). No R16e deletions: every main kiosk file exists in the R16e ref.

## Contract check (main mini -> R16e kiosk)
- The main mini subscriber publishes on `/<room>/guardian/control`: old form {"kill","modes","ts"} and, when consult_open_publish is on, {"consult_open","kill","modes","ts"}; both via json.dumps sort_keys (mini/subscriber/subscriber.py:168-186).
- The mini's CONTROL_RE is verbatim the kiosk's. R16e kiosk lib/killswitch.sh:25-38,85-95,117-125 parses both forms; kill=false is fleet=on/ok, no kill triggered. No blocker.

## Verification (Linux host t4; kiosk suite proves on macOS only)
(a) Kiosk suite `bash tools/room-guardian/kiosk/tests/run.sh` (Linux, UNPROVEN):
- tip:    `tests: 345 functions, 1230 assertions passed, 1000 failed (7 leaked sandbox dirs)`
- base:   same line at origin/cloudpane/cloud-guardian-r16e/r16e
- Per-test diff (213 not-ok functions, 7 crash/leak, same names both runs): identical. New failures vs base: 0.
(b) Mini suite `bash tools/room-guardian/mini/tests/run.sh`: `Ran 402 tests in 54.734s` / `OK (skipped=15)`, rc=0. Brief expected 40/7; current main suite is larger, the must-pass requirement is met.
(c) shellcheck 0.11.0 `-x` over the 35 kiosk .sh files: 0 findings at tip and at base (same file list).
(d) `bash scripts/steward/scrub.sh --staged`: rc=0.

## Mutants
- Suite mutant tests (t_r16d, t_r16d3, t_r16e mutants; t_r15 tree mutants) ran under both invocations; outcomes identical (environment failures, no sqlite3 on this host). Kill status UNPROVEN on Linux.

## Assumptions
- "40 tests, 7 skipped" in the brief is stale for current main; treated "must pass" as the binding requirement.
- scrub.sh requires an argument; `--staged` covers exactly this change (everything was staged).

## Open risks
- Kiosk behaviour on macOS is UNPROVEN here (1000 env failures, identical to base); re-run the suite on macOS before production.
