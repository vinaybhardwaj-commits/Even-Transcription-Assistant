PASS
# REFUTE FR1-C1 R16d-3 (canary play gates). cloud-guardian-r16d3, 16 Oct 2026. Served by claude-opus-5-5
Target: guardian/fr1-c1-r16 @ 41b88298c6ba03cdee27dbd1706b785c26516624, base 0bd8a5f4. `git rev-parse HEAD:tools/room-guardian/kiosk` = fd7b808604f7b7c295ba3ca81f8aea49b819b2f9 (matches the brief).
Diff: 9 files, +281/-42, as the brief says. bin/guardian-root.sh and lib/heal.sh are unchanged (`git diff --stat` on both is empty).
Verdict: no MUST/FAIL. I found 2 LOW test gaps (two mutants survive the builder's tests; the code is correct in both cases), 2 NITs, and 1 caveat about the environment.

## Findings, ranked
1. LOW (test gap): the committed IST date ("night") is not pinned by any builder test. Mutant m4 `canary_event_night() { ist_date; }` (canary.sh:104) passes all 20 t_r16d3 functions.
   Every per-gate test commits and aborts on the same calendar date, so the clock date and the commit date are always equal.
   My probe commits pm 22:30 on 20261014 and moves the clock to 00:10 on 20261015 between the plays. It is GREEN on head and RED on m4:
   `FAIL: night is the committed date: ["night":"20261014"] not found in [... "night":"20261015","result":"aborted:outside_window" ...]`
   The code is right (canary.sh:104 reads CANARY_COMMIT_KEY). Addendum 1 ("night is its IST date") is only proved by assertions that a wrong implementation also passes. Fix: add one test that crosses midnight.
2. LOW (test gap): the gate order is not pinned. Mutant m8 moves the consult check after the HID checks in canary_play_gate (canary.sh:266-269). It passes all 20 t_r16d3 functions.
   My probe (am slot; between the plays a consult opens AND HID goes active) is GREEN on head and RED on m8:
   `FAIL: consult reported first (canary_eligible order): ["result":"aborted:consult_not_clear"] not found`
   It is still no play either way, so only the <why> label changes. The contract says "same order", and no test enforces it.
3. NIT: canary.sh:270 reads S_pending (pending_piece_count) in the gate but never uses it.
   recorder_busy does NOT use it, so Addendum 3 "NO pending_piece_count in recorder_busy" holds. The read is dead.
4. NIT: canary_play_gate overwrites the tick globals S_state, S_capture_open, S_pending and S_rms (canary.sh:270,274).
   The canary runs last in the tick (canary_cycle is called after heal_cycle), so I found nothing that reads stale-vs-fresh wrongly. It is a side effect worth a comment.
5. CAVEAT (environment, not the commit): this is a Linux container running as root. The suite assumes macOS `date -j`, `stat -f` and `sed -i ''`.
   I ran it with harness-only PATH shims (BSD to GNU). Those shims are not in the repo.
   About 120 functions fail the same way on BOTH base 0bd8a5f4 and head: launchd/ps/ACL/owner/chmod-000 tests that root bypasses.
   `comm` of the not-ok sets, head vs base: "only head:" empty, "only base:" empty. All 22 functions added at head pass.
   The builder's Mac figure "331 functions, 2323 assertions passed, 0 failed" CANNOT be reproduced here; the run is quoted below.

## The brief's checklist
1. PASS. canary_play_gate (canary.sh:262-278) is called at canary.sh:294, inside the play loop, before canary_play_once.
   That means before play 1, and before play 2 AFTER the gap gsleep (canary.sh:290-293).
   It re-reads its inputs fresh: the clock via canary_slot_key; consult_hold_clear re-parses control.last; hid_idle_s; json_get on status.json; rms_dbfs_2s; speech_recent on the new S_rms.
   Order and reasons match canary_eligible (canary.sh:78-99): window, consult (day only), hid_unreadable, hid_active, recorder_failed, recorder_busy, not_recording, tape_not_advancing, speech (recorder_busy).
   canary_state_ok and heal_rate are correctly not re-run. The kill switch and the mode stay with act_step (canary.sh:224).
2. PASS. A failed gate does `audit "canary aborted: <why> play=<n> slot=<key>"` plus ONE canary_event "aborted:<why>" carrying play 1's numbers, then `return 0`.
   There is no escalate and no page. The slot file and last_play stay as written by canary_commit_state.
   The tests confirm no retry over 2 further eligible ticks (t_r16d3.sh:33-36).
   The aborted <why> set reachable from the gate is exactly: outside_window, consult_not_clear, hid_unreadable, hid_active, recorder_failed, recorder_busy, not_recording, tape_not_advancing.
3. PASS (code). After a commit, CANARY_COMMIT_KEY=key (canary.sh:126), and the event's slot and night come from that key (canary.sh:103-104). The key is reset at the start of every tick (canary.sh:317).
   Before a commit, would_do and refused events keep the clock's slot and date, as the contract asks. Tests: the slot is pinned (m3 RED); the night is only weakly pinned (finding 1).
4. PASS. In the pm slot the consult check is skipped because the pm slot is inside the night window (NIGHT_START 2135, pm slot 2140-2240). test_r16d3_pm_consult_opening_between_plays_does_not_abort asserts 2 plays and a pass.
5. PASS. common.sh:112 sets `g_def CANARY_PLAY_GAP_S 15`. test_r16d3_play_gap_is_15_s checks the run-mode default and the mono_ms start gap. Tests that set the gap to 0 are kept.
6. PASS. All the tests are behavioural, driven through the fakes (afplay, ioreg/hid, status.json, control.last, tape mtime, clock), plus a canary_play_once wrapper hook. None is a source-text grep.
   The in-suite mutants use sed on a copy of canary.sh that is then sourced. That is acceptable.
7. Done. I executed 8 mutants myself, each on a fresh copy of the tree, and ran TFILES="h_src.sh t_r16d3.sh". The baseline m0 is `tests: 20 functions, 125 assertions passed, 0 failed`.
   - m1 skip the gate before play 2 (`{ [ "$n" = 2 ] || canary_play_gate "$ckey"; } ||`): `tests: 20 functions, 71 assertions passed, 57 failed`. RED: gate_a_pm, a_am, b, c, d, e, f, g, h, i, play1_pass_then_abort.
     `FAIL: a/pm: exactly 1 afplay call: expected [1] got [2]` / `FAIL: a/pm: aborted:outside_window: ... "result":"pass"`
   - m2 drop the hid_active line from the gate: 9 failed. RED: play2_gate_b_hid_active, play1_gate_hid.
   - m3 hard-code the slot (`canary_event_slot() { canary_slot_name; }`): 4 failed. RED: gate_a_pm, a_am, event_never_shows_null_slot.
     `FAIL: a/pm: the committed slot name, not null: ["slot":"pm"] not found in [... "slot":null ...]`
   - m4 `canary_event_night() { ist_date; }`: 0 failed. SURVIVES (finding 1; my probe is RED).
   - m5 drop tape_not_advancing: 2 failed. RED: play2_gate_h_tape_stops.
   - m6 drop the speech arm: 5 failed. RED: play2_gate_i_speech.
   - m7 drop the consult gate: 5 failed. RED: play2_gate_d_consult_opens_am.
   - m8 consult moved after the HID checks: 0 failed. SURVIVES (finding 2; my probe is RED).
8. PASS. I looked for any way the speaker plays during a consult, with a person at the keyboard, or outside the committed window.
   - The gap between the gate and afplay is only a mono_ms read, a tape stat and act_step (kill switch and mode), all milliseconds. Nothing else runs between them.
   - Play 1's gate runs after system_profiler and the WAV build, so it is later than canary_eligible.
   - The window check is an equality on the committed key, so a clock jump into another slot also aborts.
   - consult_hold_clear is fail-closed (no command, stale, unparseable or kill all count as hold).
   - An empty or non-digit HID value gives hid_unreadable.
   No path plays without passing canary_play_gate.
   Design note (not a fault): an abort before play 1 forfeits the slot, because commit and last_play are already written. That is what the contract asks for.

## Gate lines I ran (shims: date/stat/sed, BSD to GNU; TMPDIR in the scratchpad)
- `bash tests/run.sh` at head: `tests: 331 functions, 1702 assertions passed, 539 failed (1 leaked sandbox dirs)`
- the same at base 0bd8a5f4: `tests: 309 functions, 1569 assertions passed, 541 failed (1 leaked sandbox dirs)`
  - not-ok diff, head vs base: empty both ways.
  - The leak is the same function on both (test_endless_line_without_lf..., a CRASH).
  - Base failing 2 more assertions than head is all in shared tests, by function set.
- `TFILES="t_canary.sh t_r16d.sh t_r16d3.sh"`: `tests: 71 functions, 430 assertions passed, 3 failed`. The 3 assertions are in test_night_state_fails_closed and test_unreadable_directory_and_garbage_actions_log_count_as_cap_reached: chmod 000 under root, and they fail on base too.
- mini: `python3 -m unittest discover -s tests -v` gives `Ran 40 tests in 0.116s` / `OK (skipped=7)`
- shellcheck 0.11.0: `git ls-files '*.sh' | xargs shellcheck -x` over 38 files gives `sc rc=0`
- gitleaks 8.21.2 `git --log-opts=0bd8a5f4..41b88298`: `1 commits scanned.` / `no leaks found`
- The C3 grep on kiosk/ was NOT run: the brief does not give its pattern.
