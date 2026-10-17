#!/bin/bash
# shellcheck disable=SC2030,SC2031,SC1091,SC2154
# R16e (fable SHOULD-1, SHOULD-2): in canary_play_gate the kill switch and the mode come first; before play 2 the whole gap since play 1 ended is scanned for speech.
# Uses r6_at / r6_mut / cn_* / r3_hook from t_canary.sh, t_r16d.sh and t_r16d3.sh (sourced before this file).

# a fresh new-form control payload with kill true (consult_open false for this room): the kill switch engages and the consult hold is no longer clear
r16e_kill() { printf '%s\n{"consult_open": {"opd9": false}, "kill": true, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"; }

# r16e_gap <speech start s|-> [speech len s]: append a 15 s gap to the tape (quiet bed RMS 100 at 1 kHz, as mk_pcm_tone), with 2 s of speech-level sound (RMS 2000, 300 Hz) at <start>
r16e_gap() {
  local tape="$RR_ROOT/captures/c1/seg_001/tape.pcm"
  perl -e 'my($st,$ln)=@ARGV; my @s; for my $i (0..(15*16000-1)) { my $t=$i/16000; my($a,$f)=($st ne "-" && $t>=$st && $t<$st+$ln) ? (2000,300) : (100,1000); push @s, int($a*1.41421356*sin(6.28318530718*$f*$i/16000)+0.5) } print pack("s<*",@s)' "$1" "${2:-2}" >>"$tape"
  touch -t "$(date -j -f %s "$GUARDIAN_FAKE_NOW" +%Y%m%d%H%M.%S)" "$tape"
}

# r16e_abort <name> <HH:MM> <hook> <result> <audit why>: play 1 runs clean, <hook> runs between the plays; play 2 must not fire
r16e_abort() {
  local name="$1" at="$2" cmd="$3" res="$4" why="$5" slot ev
  r6_at "$at"
  case "$at" in 2*) slot=pm ;; *) slot=am ;; esac
  r3_hook 1 "$cmd"
  cn_run
  ev="$(cn_events)"
  assert_eq "$(cn_plays)" "1" "$name: exactly 1 afplay call"
  assert_eq "$(r3_events_n)" "1" "$name: one event"
  assert_has "$ev" "\"result\":\"$res\"" "$name: $res"
  assert_eq "$(printf '%s' "$ev" | grep -o '"rise_db_band"' | wc -l | tr -d ' ')" "1" "$name: plays has 1 element"
  assert_has "$ev" "\"slot\":\"$slot\"" "$name: the committed slot name"
  assert_has "$ev" "\"night\":\"20261014\"" "$name: the committed IST date"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "canary aborted: $why play=2 slot=20261014-$slot" "$name: audit line"
}

# ---- SHOULD-1: a kill between the plays is the kill result (would_do, the existing kill word), never aborted:consult_not_clear ----
test_r16e_kill_between_plays_am_is_kill_not_consult() {
  r16e_abort "kill/am" 07:30 'r16e_kill' would_do kill
  assert_not "$(cn_events)" 'consult_not_clear' "kill/am: never consult_not_clear"
}
test_r16e_kill_between_plays_pm_is_kill() {
  r16e_abort "kill/pm" 22:00 'r16e_kill' would_do kill
  assert_not "$(cn_events)" 'consult_not_clear' "kill/pm: never consult_not_clear"
}
# the mode turns shadow between the plays (control still fresh, consult still clear): the mode word, not a play
test_r16e_shadow_between_plays_am_is_mode_not_heal() {
  r16e_abort "shadow/am" 07:30 'printf "%s\n{\"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"shadow\"}, \"ts\": %s}\n" "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"' would_do mode_not_heal
}

# ---- SHOULD-2: speech anywhere in the 15 s gap aborts play 2 ----
test_r16e_gap_speech_at_start_aborts() { r16e_abort "gap start" 22:00 'r16e_gap 0' aborted:speech speech; }
test_r16e_gap_speech_in_middle_aborts() { r16e_abort "gap middle" 22:00 'r16e_gap 6.5' aborted:speech speech; }
test_r16e_gap_speech_late_aborts() { r16e_abort "gap late" 22:00 'r16e_gap 10.5' aborted:speech speech; }
# speech in the last 2 s of the gap: the existing speech arm (rms_dbfs_2s, t_r16d3 case i) sees it first and keeps its word, recorder_busy
test_r16e_gap_speech_at_end_aborts() { r16e_abort "gap end" 22:00 'r16e_gap 13' aborted:recorder_busy recorder_busy; }
test_r16e_gap_speech_is_noted() {
  r16e_abort "gap noted" 22:00 'r16e_gap 0' aborted:speech speech
  assert_eq "$(cat "$STATE_DIR/speech_seen" 2>/dev/null)" "$GUARDIAN_FAKE_NOW" "the gap's speech is noted in speech_seen"
}
test_r16e_gap_silence_still_plays() {
  r6_at 22:00
  r3_hook 1 'r16e_gap -'
  cn_run
  assert_eq "$(cn_plays)" "2" "silence across the gap: 2 plays"
  assert_has "$(cn_events)" '"result":"pass"' "silence across the gap: pass"
}

# ---- EXECUTED mutants (inside the suite; the same mutants run against the whole file are quoted in the build report) ----
# M1: the kill-first ordering removed (both the kill and the mode lines). In the am slot a kill between the plays then reads as consult_not_clear.
test_r16e_mutant_kill_first_removed() {
  R16E_MUT='/CANARY_WHY="kill"; return 1; fi$/d; /CANARY_WHY=mode_not_heal; return 1; }$/d'
  r6_at 07:30; r6_mut "$R16E_MUT"; r3_hook 1 'r16e_kill'; cn_run
  assert_has "$(cn_events)" '"result":"aborted:consult_not_clear"' "M1: the am kill test would be red (aborted:consult_not_clear)"
}
# M2: the speech window shrunk back to the last 2 s of tape. Speech at the start of the gap is then missed and play 2 fires.
test_r16e_mutant_speech_window_2s() {
  R16E_MUT='s/then off="\$2"; else/then off=$((sz - 64000)); else/'
  r6_at 22:00; r6_mut "$R16E_MUT"; r3_hook 1 'r16e_gap 0'; cn_run
  assert_eq "$(cn_plays)" "2" "M2: play 2 fires (the start-of-gap test expects 1)"
}
