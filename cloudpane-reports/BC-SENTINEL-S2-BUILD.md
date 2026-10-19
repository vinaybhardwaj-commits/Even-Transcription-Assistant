# BC-SENTINEL-S2-BUILD (lane bc-s2, branch bc/sentinel-s2, base 80e25e57)
Sense only: the kiosk health line reports how silent the mic is and the room's mic class. No new fault codes, decisions or heal changes.

## Changed (tools/room-guardian only)
- kiosk/lib/collect.sh: new `tape_stats_2s` = ONE od|awk pass giving `rms zr peak` (zr = share of samples exactly 0, %.3f; peak = abs max/32768, %.4f). `rms_dbfs_2s` now wraps it and prints the same bytes as before; `collect_all` reads the tape once (S_rms, S_zr, S_peak). Same freshness gate (no file / stale / future mtime -> all empty). Health line appends `"zr","peak","mic_class"` after `guardian`; every old key and its order are unchanged. Unknown/empty class prints null.
- kiosk/lib/conf.sh, common.sh: key `GUARDIAN_MIC_CLASS` (shape-checked only); `mic_class_apply` resolves webcam|tonor, anything else -> unknown, never marks the conf bad. tonor sets USB_MIC_PATTERN=TONOR unless the conf names USB_MIC_PATTERN (even equal to C270).
- kiosk/install.sh: `--mic-class webcam|tonor` writes/replaces one `GUARDIAN_MIC_CLASS` line in the conf (from --config, else the existing conf, else the stub); bad/missing/empty value -> rc 2 "must be webcam or tonor", nothing installed. guardian.conf.example documents it.
- tests: kiosk/tests/t_sentinel_sense.sh (13 functions, 33 assertions, PCM built with bash printf); mini/tests/test_subscriber.py +1 test (unknown keys zr/peak/mic_class pass through unchanged).

## Gates (Linux host, UNPROVEN for the kiosk suite; macOS needed)
- New file alone: `tests: 13 functions, 33 assertions passed, 0 failed (0 leaked sandbox dirs)`. It adds a stat shim in the sandbox when BSD `stat -f` is absent; install-write case SKIPs off macOS (UNPROVEN).
- Kiosk suite base 80e25e57: `tests: 345 functions, 1232 assertions passed, 998 failed (7 leaked sandbox dirs)`; tip: `tests: 358 functions, 1264 assertions passed, 999 failed (7 leaked sandbox dirs)`. Failing function set identical (213 vs 213, diff empty): new failing functions 0. The +1 failed assertion is inside already-failing `the same modes under umask 000 and 022` (GNU `stat -f` fs-info text in its message), not new code.
- t_static.sh: `tests: 7 functions, 13 assertions passed, 0 failed` (base and tip).
- Mini suite: base `Ran 402 tests ... OK (skipped=15)`; tip `Ran 403 tests ... OK (skipped=15)`.
- shellcheck -x on collect.sh conf.sh common.sh install.sh: 0 findings at base and tip; new test file clean.
- scrub.sh origin/main..HEAD: see .done line.

## Mutants (t_sentinel_sense.sh), 4/4 killed, all reverted
1. zr counts |s|<=1: killed (test_stats_only_exact_zero_counts_as_zero).
2. peak /32767: killed (test_stats_peak_divides_by_32768, sample 444 prints 0.0135 vs 0.0136).
3. unknown defaults to webcam: killed (4 assertions).
4. freshness check dropped: killed (5 assertions). It is the one shared gate, so the stale checks for rms and the new fields go together.
(First pass left 1 and 2 surviving; the two fixtures above were added, then both died.)

## Assumptions
- Health keys are named `zr`, `peak`, `mic_class` exactly as the brief; they sit after `guardian`, in that order. (Mini subscriber already reads a field `zero_ratio`; unchanged, not wired to `zr`.)
- A GUARDIAN_MIC_CLASS value that is odd but printable resolves to unknown instead of killing the agent (brief: "any other value -> unknown"). Characters outside [A-Za-z0-9 ._+()-] or over 64 chars are rejected like any other conf value.
- Class tonor with no USB_MIC_PATTERN in conf also changes the pattern used by the existing USB/engine presence checks (as the brief orders).

## Open risks
- install --mic-class write path proven only by a manual run of the merge block on Linux; the full install test runs on macOS only (SKIP here). fable-deputy should rerun the kiosk suite on the Mini.
