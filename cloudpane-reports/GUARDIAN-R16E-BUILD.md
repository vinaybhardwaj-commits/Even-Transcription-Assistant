# GUARDIAN R16e BUILD (cloud-guardian-r16e). Base 41b88298 (R16d-3). GUARDIAN_VERSION c1-0.4.8-r16e
## What changed (tools/room-guardian/kiosk/lib/canary.sh unless noted)
- :301-302 SHOULD-1: canary_play_gate checks killswitch_engaged (CANARY_WHY kill) and current_mode!=heal (mode_not_heal) FIRST, before consult_hold_clear.
- :320-323 canary_play_aborted: kill|mode_not_heal emits result `would_do` (the existing kill word; the pinned test t_r16d.sh:181 expects would_do for a kill between plays, so `aborted:kill` would break an existing test); audit `canary aborted: kill play=2 slot=<key>`. Never aborted:consult_not_clear.
- :234 play_once records P_END_FILE/P_END_SIZE (tape position where play 1 ended); :344 copies them into CANARY_P1_FILE/SIZE (reset per slot at the top of canary_play_and_confirm).
- :261 canary_speech_peak: loudest 2 s window (the rms_dbfs_2s statistic), hop 0.25 s, over a byte range; under 2 s it measures the whole range.
- :277 canary_gap_speech: scans EVERY byte written since play 1 ended (rolled segment: last GAP+2 s of the new file); a hit is noted in speech_seen via note_speech.
- :315 SHOULD-2: before play 2, speech anywhere in the gap aborts with `aborted:speech`. It runs AFTER the existing speech arm, so speech in the last 2 s keeps its R16d-3 word `aborted:recorder_busy` (t_r16d3 case i is unchanged).
- :339 the gate call keeps its R16d-3 form `canary_play_gate "$ckey" || {...}` (the R16d-3 in-suite mutant sed matches it).
- lib/common.sh:7 version; tests/t_control.sh:902 and tests/t_usb.sh:336 version assertions. No other existing test was edited.
- Abort why set now: outside_window consult_not_clear hid_unreadable hid_active recorder_failed recorder_busy not_recording tape_not_advancing speech (+ kill/mode_not_heal -> would_do).
## New tests: tests/t_r16e.sh (11 functions, 62 assertions, all ok)
- kill_between_plays_am_is_kill_not_consult; kill_between_plays_pm_is_kill; shadow_between_plays_am_is_mode_not_heal
- gap_speech_at_start (0-2 s), in_middle (6.5-8.5 s), late (10.5-12.5 s) -> aborted:speech; at_end (13-15 s) -> aborted:recorder_busy (existing arm sees it first); gap_speech_is_noted; gap_silence_still_plays (2 plays, pass)
- in-suite mutants: mutant_kill_first_removed, mutant_speech_window_2s
- Each abort test asserts: 1 afplay, 1 event, plays has 1 element, slot = committed name, night 20261014, audit line.
## Suite (Linux; see the caveat)
- The kiosk suite is macOS-shaped (BSD `date -j`, `stat -f`, root-owned files/ACLs, launchd, pinned /usr/bin paths). On Linux I ran it with a test-only BSD date/stat shim on PATH, outside the repo.
- R16e full run: `tests: 342 functions, 1782 assertions passed, 523 failed (0 leaked sandbox dirs)`
- Base 41b88298, same host and shim: `tests: 331 functions, 1719 assertions passed, 523 failed (0 leaked sandbox dirs)`
- Failing test sets compared: 0 new failures in R16e. Base-only: test_probe_leaves_no_descendant_behind (timing). Every remaining failure also fails on base (Linux/root env: install, ACL, launchd, conf, usb, control-loop). macOS-only verdict: UNPROVEN here, so run the full suite on the Mini.
- Honest note: an earlier R16e full run (pre-fix) failed test_r16d3_mutant_gate_before_play2_removed because I had reshaped the gate call line. Fixed (:339) and reran; that test now passes. The full run therefore ran twice, not once.
- Canary files alone (t_canary t_r16d t_r16d3) at base: 3 failed assertions, all root-only (chmod 000 still readable as root): test_night_state_fails_closed, test_unreadable_directory_and_garbage_actions_log_count_as_cap_reached.
- mini/tests/run.sh: `Ran 40 tests ... OK (skipped=7)`, rc 0. shellcheck -x 0.11.0 on every tracked tools/room-guardian *.sh and t_r16e.sh: rc 0. swift and the macOS-only suites: cannot run here.
## Mutants EXECUTED against the real t_r16e tests (mutated copy of kiosk/ in scratch)
- M1 `sed '/CANARY_WHY="kill"; return 1; fi$/d; /CANARY_WHY=mode_not_heal; return 1; }$/d'`:
  ` not ok test_r16e_kill_between_plays_am_is_kill_not_consult`
  `  FAIL: kill/am: would_do: ["result":"would_do"] not found in [... "result":"aborted...`
  `  FAIL: kill/am: never consult_not_clear: [consult_not_clear] unexpectedly present`
  (pm and shadow tests also red on their audit lines.) `tests: 11 functions, 58 assertions passed, 6 failed`
- M2 `sed 's/then off="\$2"; else/then off=$((sz - 64000)); else/'` (window back to the last 2 s):
  ` not ok test_r16e_gap_speech_at_start_aborts`
  `  FAIL: gap start: exactly 1 afplay call: expected [1] got [2]`
  `  FAIL: gap start: aborted:speech: ["result":"aborted:speech"] not found in [...`
  (middle, late and noted also red.) `tests: 11 functions, 46 assertions passed, 18 failed`
- In each mutant tree its own in-suite mutant test reports "mutation did not apply", which is expected because the source is already mutated.
## Risk to flag
- If tape lag pushes play 1's tone tail past the play-1 sample point (lag over SAMPLE_S-2.5 s = 4.5 s), the gap scan reads it as speech and aborts play 2 (fail closed: aborted, never pass).
## Scrub
- `bash scripts/steward/scrub.sh origin/guardian/fr1-c1-r16..HEAD` rc 0 (gitleaks 8.21.2 in scratch; 8.18.4 lacked the git subcommand, rc 2), run on the code commit and again on HEAD.
## FIX (fable ruling on refute GUARDIAN-R16E-VERDICT, PASS-WITH-FIXES). Test-only; no lib change
- A1: KEEP would_do for kill/mode between plays. Unchanged.
- A2: tests/t_r16e.sh test_r16e_play1_position_reset_per_slot. Two consecutive slots in ONE process: pm plays twice, then the next am slot's tape has 3 s of speech-level sound just past the stale CANARY_P1_SIZE, followed by 6 s of quiet. With the reset (canary.sh:330), the am slot plays twice and passes.
- A3: test_r16e_gap_loud_half_second_burst_aborts (RMS 2000 burst, 0.5 s, 7.75-8.25 s of the gap) and test_r16e_gap_half_second_burst_pins_hop (RMS 240 on a bed of RMS 30). With the burst inside one 2 s window that window reads -48.5 dBFS; split across two windows each reads -51.3 dBFS; the gate is -50. Both pass at the existing hop of 0.25 s (4000 samples), so the hop was not shrunk. A speech-loud burst alone cannot pin the hop, because any 2 s window holding even part of it clears the gate.
- A4: r16e_abort now also asserts, after re-arming the clock, status, tape and control and running 2 more ticks: still 1 afplay call, no second event, and the slot file still holds the committed key (as r3_case).
- Run (Linux, BSD date/stat shim; t_canary.sh is sourced as a dependency and its tests run too):
  `TFILES="t_canary.sh t_r16d.sh t_r16d3.sh t_r16e.sh"`: `tests: 85 functions, 542 assertions passed, 3 failed (0 leaked sandbox dirs)`
  The 3 failed assertions are the pre-existing root-only t_canary ones (test_night_state_fails_closed, test_unreadable_directory_and_garbage_actions_log_count_as_cap_reached), also red at base 41b88298. t_r16d.sh, t_r16d3.sh and t_r16e.sh: 0 failures. t_r16e: 14 functions ok.
- Mutants EXECUTED (mutated kiosk/ copy in scratch, real t_r16e tests):
  a4 `sed 's/CANARY_PLAYS=""; CANARY_P1_FILE=""; CANARY_P1_SIZE=""/CANARY_PLAYS=""/'` KILLED:
  ` not ok test_r16e_play1_position_reset_per_slot`
  `  FAIL: slot 2 (am): 2 plays (no stale gap scan before play 1): expected [2] got [0]`
  `  FAIL: slot 2: never aborted:speech: [aborted:speech] unexpectedly present`  (`tests: 14 functions, 109 assertions passed, 3 failed`)
  a6 `sed 's/W = 32000; H = 4000;/W = 32000; H = 32000;/'` (hop 2 s) KILLED:
  ` not ok test_r16e_gap_half_second_burst_pins_hop`
  `  FAIL: burst hop: exactly 1 afplay call: expected [1] got [2]`  (`tests: 14 functions, 107 assertions passed, 5 failed`)
- shellcheck -x tests/t_r16e.sh rc 0. scrub.sh origin/guardian/fr1-c1-r16..HEAD rc 0 (gitleaks 8.21.2).
