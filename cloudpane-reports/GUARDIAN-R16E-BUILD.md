# GUARDIAN R16e BUILD (cloud-guardian-r16e, builder cloud-guardian-r16e-w, 17 Oct 2026)
Base 41b88298 (R16d-3). Branch cloudpane/cloud-guardian-r16e-w/r16e. GUARDIAN_VERSION c1-0.4.8-r16e.

## What changed (tools/room-guardian/kiosk)
- lib/canary.sh:300 SHOULD-1. The first gate in canary_play_gate is `act_step || { CANARY_WHY=would_do; return 1; }`. It runs before the window and consult_hold_clear checks.
  - The reason word is the existing kill/mode word, would_do (ruling 1's "or the existing kill reason word"). act_step audits it as before.
  - Why would_do and not aborted:kill: the existing tests t_canary.sh test_direct_call_in_shadow_makes_no_afplay_call and t_r16d.sh test_r16d_kill_switch_between_plays_gives_one_play_and_would_do assert would_do. "Existing tests unchanged" forbids editing them.
  - An earlier draft emitted aborted:kill and turned both of those tests red. If fable prefers aborted:kill, those two assertions must change.
- lib/canary.sh:318 canary_gate_abort. A would_do from the gate gives the would_do event, with play 1's numbers when play 1 ran. Every other gate gives `aborted:<why>` plus the audit line, as before.
- lib/canary.sh:234 canary_play_once also sets P_FILE and P_END, the tape file and byte size where this play's measured range ends.
- lib/canary.sh:329 and :343 canary_play_and_confirm resets CANARY_GAP_TAPE and CANARY_GAP_OFF, then sets them after play 1. The call stays `canary_play_gate "$ckey" ||` (:338), so the R16d-3 mutant sed still applies.
- lib/canary.sh:260 canary_rms_peak2s gives the loudest 2 s window (hop 0.5 s, the rms_dbfs_2s statistic) over a byte range. A range under 2 s is treated as one window.
- lib/canary.sh:277 canary_gap_speech, SHOULD-2. It checks the tape from play 1's end offset to now. A segment that rolled counts as gap from byte 0. An unreadable size fails closed.
  - Speech anywhere in that range makes the gate return recorder_busy and writes speech_seen, as note_speech does. The gate calls it at :312, before speech_recent, and only before play 2.
- lib/common.sh:7 GUARDIAN_VERSION c1-0.4.8-r16e. tests/t_control.sh:902 and tests/t_usb.sh:336 have the version assertion only.
- New file tests/t_r16e.sh. No other test was changed.

## Tests (tests/t_r16e.sh, 9 functions, 52 assertions)
- kill_between_plays_am_is_would_do_not_consult and kill_between_plays_pm_is_would_do. Each asserts:
  - 1 afplay call, 1 event, result would_do and never consult_not_clear;
  - plays has 1 element, with the committed slot and night;
  - the act_step kill audit line;
  - no retry.
- gap_speech_at_start, gap_speech_in_middle and gap_speech_at_end_aborts_play2 put 1 s of RMS 3000 at 0, 7 and 14 s of a 15 s gap of quiet bed. Each gives aborted:recorder_busy with the full r3_case checks.
- gap_speech_is_remembered: speech_seen is written.
- gap_silent_still_plays_twice: 2 plays, result pass.
- Two in-suite executed mutants, matching the out-of-suite runs below.

## Suite (Linux, BSD date/stat shims kept in scratch, not in the repo; TMPDIR in scratch)
- HEAD 2b75115e, kiosk tests/run.sh full, once: `tests: 340 functions, 1769 assertions passed, 525 failed (0 leaked sandbox dirs)`
- Base 41b88298, same host: `tests: 331 functions, 1715 assertions passed, 527 failed (0 leaked sandbox dirs)`
- The failing function sets are identical: 110 functions on each, none only at base, none only at HEAD. They are macOS-only: ACLs, chmod +a, sudo/root helper, launchd, TCC sqlite3.
  - The macOS full suite cannot run here. The 9 new functions plus the 20 R16d-3 functions are green. Treat this as UNPROVEN on macOS until the 21:30 suite runs.
- Mini suite tools/room-guardian/mini/tests/run.sh: `Ran 40 tests ... OK (skipped=7)`.
- shellcheck 0.11.0 -x on all tracked tools/room-guardian *.sh after the last edit: rc 0.

## Mutants (EXECUTED out of suite on copies of the final tree, t_r16e.sh run against each)
- M1: the kill/mode line moved after the consult gate. `tests: 9 functions, 49 assertions passed, 3 failed`
  - ` not ok test_r16e_kill_between_plays_am_is_would_do_not_consult`
  - `  FAIL: kill/am: the kill reason word would_do: ["result":"would_do"] not found in [...]`
  - `  FAIL: kill/am: never consult_not_clear: [consult_not_clear] unexpectedly present`
  - The pm case stays green under M1, as expected: there is no consult gate at night.
- M2: the speech window shrunk to the last 2 s (`off=$((sz - 64000))`). `tests: 9 functions, 41 assertions passed, 12 failed`
  - ` not ok test_r16e_gap_speech_at_start_aborts_play2`
  - `  FAIL: gap start: exactly 1 afplay call: expected [1] got [2]`
  - `  FAIL: gap start: aborted:recorder_busy: ["result":"aborted:recorder_busy"] not found in [... "result":"pass" ...]`
  - middle and remembered also go red. In this run the in-suite mutant test says "mutation did not apply" because the lib was already mutated.

## Scrub
- `bash scripts/steward/scrub.sh origin/guardian/fr1-c1-r16..HEAD`: rc 0 (gitleaks v8.21.2, installed to scratch with go install).

## Residual, for fable
- The gap starts where play 1's measured range ends, CANARY_SAMPLE_S (7 s) after play 1 started.
- Tape from the end of the tone to 7 s lies inside play 1's burst range, and no speech check covers it. The tone's position there moves with the tape lag, so a speech window over that span would catch the tone itself.
- In production the checked gap is about 8 s of the 15 s.
