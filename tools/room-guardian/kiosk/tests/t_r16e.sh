#!/bin/bash
# shellcheck disable=SC2030,SC2031,SC2154,SC1091
# R16e (fable rulings on the R16d-3 refute SHOULDs): canary_play_gate checks the kill switch and the mode FIRST; before play 2 the speech check covers the whole gap since play 1.
# Uses r6_at / r6_mut / cn_* / r3_* from t_canary.sh, t_r16d.sh and t_r16d3.sh (sourced before this file).

# a fresh control payload with kill true (consult_open false for this room, so only the kill can hold the consult gate)
r16e_kill() {
  printf '%s\n{"consult_open": {"%s": false}, "kill": true, "modes": {"%s": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_ROOM" "$GUARDIAN_ROOM" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"
  rm -f "$STATE_DIR/control_latch"
}

# r16e_gap <speech start s | none>: append the 15 s gap to the tape: the quiet bed (1 kHz, RMS 100, under the -50 dBFS gate) with 1 s of speech-level sound (RMS 3000) at <start>
r16e_gap() {
  perl -e 'my $sp = $ARGV[0]; my @s; for my $i (0..239999) { my $r = ($sp ne "none" && $i >= $sp * 16000 && $i < ($sp + 1) * 16000) ? 3000 : 100; push @s, int($r*1.41421356*sin(6.28318530718*1000*$i/16000)+0.5) } print pack("s<*", @s)' "$1" >>"$RR_ROOT/captures/c1/seg_001/tape.pcm"
  touch -t "$(date -j -f %s "$GUARDIAN_FAKE_NOW" +%Y%m%d%H%M.%S)" "$RR_ROOT/captures/c1/seg_001/tape.pcm"
}

# SHOULD-1: a kill between the plays is aborted:kill in both slots (in the am slot the kill payload also holds the consult gate; it must not read as consult_not_clear)
test_r16e_kill_between_plays_am_is_aborted_kill() { r3_case "kill/am" 07:30 'r16e_kill' kill; }
test_r16e_kill_between_plays_pm_is_aborted_kill() { r3_case "kill/pm" 22:00 'r16e_kill' kill; }

# SHOULD-2: speech anywhere in the 15 s gap aborts play 2 (start and middle are outside the last 2 s of tape)
test_r16e_gap_speech_at_start_aborts_play2() { r3_case "gap start" 22:00 'r16e_gap 0' recorder_busy; }
test_r16e_gap_speech_in_middle_aborts_play2() { r3_case "gap middle" 22:00 'r16e_gap 7' recorder_busy; }
test_r16e_gap_speech_at_end_aborts_play2() { r3_case "gap end" 22:00 'r16e_gap 14' recorder_busy; }
test_r16e_gap_speech_is_remembered() {
  r6_at 22:00; rm -f "$STATE_DIR/speech_seen"
  r3_hook 1 'r16e_gap 0'
  cn_run
  assert_eq "$(cat "$STATE_DIR/speech_seen" 2>/dev/null)" "$GUARDIAN_FAKE_NOW" "gap speech written to speech_seen (as note_speech does)"
}
test_r16e_gap_silent_still_plays_twice() {
  r6_at 22:00
  r3_hook 1 'r16e_gap none'
  cn_run
  assert_eq "$(cn_plays)" "2" "silent gap: 2 afplay calls"
  assert_has "$(cn_events)" '"result":"pass"' "silent gap: pass"
}

# EXECUTED mutant (SHOULD-1): the kill and mode lines moved after the consult gate. The am kill case then reads consult_not_clear (the am test above would be red).
test_r16e_mutant_kill_after_consult_gives_consult_not_clear_am() {
  r6_at 07:30
  awk '/^canary_play_gate\(\)/ { g = 1 } g && /CANARY_WHY="kill"|CANARY_WHY=mode/ { held = held $0 "\n"; next } { print } g && /CANARY_WHY=consult_not_clear/ { printf "%s", held; g = 0 }' \
    "$KDIR/lib/canary.sh" >"$T/canary_mut.sh"
  assert_eq "$(grep -c 'CANARY_WHY="kill"' "$T/canary_mut.sh")" "1" "mutant applied (one kill line)"
  assert_eq "$(awk '/^canary_play_gate\(\)/ { g = 1 } g && /consult_hold_clear/ { print "consult"; exit } g && /CANARY_WHY="kill"/ { print "kill"; exit }' "$T/canary_mut.sh")" "consult" "mutant: consult before kill"
  . "$T/canary_mut.sh"
  r3_hook 1 'r16e_kill'
  cn_run
  assert_has "$(cn_events)" '"result":"aborted:consult_not_clear"' "mutant: aborted:consult_not_clear (the real test expects aborted:kill)"
}

# EXECUTED mutant (SHOULD-2): the speech window shrunk back to the last 2 s of tape. Speech at the start of the gap then plays twice (the start test above would be red).
test_r16e_mutant_speech_window_2s_misses_gap_start() {
  r6_at 22:00
  r6_mut 's/^  db="\$(canary_rms_peak2s/  off=$((sz - 64000)); [ "$off" -ge 0 ] || off=0; &/'
  r3_hook 1 'r16e_gap 0'
  cn_run
  assert_eq "$(cn_plays)" "2" "mutant: play 2 fires over speech at the gap start (the real test expects 1)"
}
