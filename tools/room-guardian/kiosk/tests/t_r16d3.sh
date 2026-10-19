#!/bin/bash
# shellcheck disable=SC2030,SC2031,SC1091,SC2010,SC2154
# R16d-3 (fable G2/G1): canary_play_gate re-checks every gate on freshly read inputs directly before EACH play; a failed gate aborts the slot.
# Uses r6_at / cn_* from t_canary.sh and t_r16d.sh (sourced before this file).

# r3_hook <n> <commands...>: wrap canary_play_once so that <commands> run right after play <n> has been measured (that is: between play n and the gate before the next).
r3_hook() {
  R3_AFTER="$1"; R3_CMD="$2"; R3_N=0
  eval "$(declare -f canary_play_once | sed '1s/canary_play_once/r3_orig_play_once/')"
  canary_play_once() { local rc; r3_orig_play_once "$@"; rc=$?; R3_N=$((R3_N + 1)); [ "$R3_N" = "$R3_AFTER" ] && eval "$R3_CMD"; return $rc; }
}
r3_events_n() { cn_events | wc -l | tr -d ' '; }
r3_tone_loud() { perl -e 'print pack("s<*", map { int(2829*1.41421356*sin(6.28318530718*$_/16)+0.5) } 0..31999)' >>"$RR_ROOT/captures/c1/seg_001/tape.pcm"; touch -t "$(date -j -f %s "$GUARDIAN_FAKE_NOW" +%Y%m%d%H%M.%S)" "$RR_ROOT/captures/c1/seg_001/tape.pcm"; }
# the clock moves to <HH:MM> with everything else fresh (control payload, mode, tape mtime): only the window can fail
r3_clock() { GUARDIAN_FAKE_NOW="$(ist_epoch "$1")"; consult_clear; go_heal; touch -t "$(date -j -f %s "$GUARDIAN_FAKE_NOW" +%Y%m%d%H%M.%S)" "$RR_ROOT/captures/c1/seg_001/tape.pcm"; }
r3_consult_open() { printf '%s\n{"consult_open": {"opd9": true}, "kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"; }

# r3_case <name> <slot HH:MM> <hook commands> <expected why>
r3_case() {
  local name="$1" at="$2" cmd="$3" why="$4" slot ev
  r6_at "$at"
  case "$at" in 2*) slot=pm ;; *) slot=am ;; esac
  r3_hook 1 "$cmd"
  cn_run
  ev="$(cn_events)"
  assert_eq "$(cn_plays)" "1" "$name: exactly 1 afplay call"
  assert_eq "$(r3_events_n)" "1" "$name: one event"
  assert_has "$ev" "\"result\":\"aborted:$why\"" "$name: aborted:$why"
  assert_eq "$(printf '%s' "$ev" | grep -o '"rise_db_band"' | wc -l | tr -d ' ')" "1" "$name: plays has 1 element"
  assert_has "$ev" "\"slot\":\"$slot\"" "$name: the committed slot name, not null"
  assert_has "$ev" "\"night\":\"20261014\"" "$name: the committed IST date"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "canary aborted: $why play=2 slot=20261014-$slot" "$name: audit line"
  # not retried: the clock back inside the window and eligible again, several ticks
  GUARDIAN_FAKE_NOW="$(ist_epoch "$at")"; write_status; mk_pcm_tone 100 10; consult_clear; go_heal
  cn_run; cn_run
  assert_eq "$(cn_plays)" "1" "$name: not retried (still 1 afplay call)"
  assert_eq "$(r3_events_n)" "1" "$name: no second event"
}

test_r16d3_play2_gate_a_window_pm() { r3_case "a/pm" 22:30 'r3_clock 22:41' outside_window; }
test_r16d3_play2_gate_a_window_am() { r3_case "a/am" 08:10 'r3_clock 08:21' outside_window; }
test_r16d3_play2_gate_b_hid_active() { r3_case "b" 22:00 'echo 5000000000 >"$T/hid"' hid_active; }
test_r16d3_play2_gate_c_hid_unreadable() { r3_case "c" 22:00 'printf "#!/bin/bash\nexit 1\n" >"$T/bin/ioreg"; chmod +x "$T/bin/ioreg"' hid_unreadable; }
test_r16d3_play2_gate_d_consult_opens_am() { r3_case "d" 07:30 'r3_consult_open' consult_not_clear; }
test_r16d3_play2_gate_e_paused() { r3_case "e" 22:00 'write_status state=paused' recorder_busy; }
test_r16d3_play2_gate_f_failed() { r3_case "f" 22:00 'write_status state=failed' recorder_failed; }
test_r16d3_play2_gate_g_state_empty() { r3_case "g" 22:00 'write_status state=' not_recording; }
test_r16d3_play2_gate_h_tape_stops() { r3_case "h" 22:00 'touch -t 202610140000 "$RR_ROOT"/captures/c1/seg_001/tape.pcm' tape_not_advancing; }
test_r16d3_play2_gate_i_speech() { r3_case "i" 22:00 'r3_tone_loud' recorder_busy; }

# play 1: a gate that fails after act_begin and the commit but before play 1
test_r16d3_play1_gate_hid() {
  local ev
  r6_at 22:00
  eval "$(declare -f canary_make_wav | sed '1s/canary_make_wav/r3_orig_make_wav/')"
  canary_make_wav() { r3_orig_make_wav "$@"; echo 5000000000 >"$T/hid"; }
  cn_run
  ev="$(cn_events)"
  assert_eq "$(cn_plays)" "0" "0 afplay calls"
  assert_has "$ev" '"result":"aborted:hid_active"' "aborted:hid_active"
  assert_has "$ev" '"slot":"pm"' "committed slot name"
  assert_has "$ev" '"plays":\[\]' "no plays"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "canary aborted: hid_active play=1 slot=20261014-pm" "audit"
  assert_eq "$(cat "$CANARY_SLOT_FILE")" "20261014-pm" "the slot stays committed"
}

# the consult gate is by day only: in the pm slot a consult opening between the plays does not abort
test_r16d3_pm_consult_opening_between_plays_does_not_abort() {
  r6_at 22:00
  r3_hook 1 'r3_consult_open'
  cn_run
  assert_eq "$(cn_plays)" "2" "2 plays"
  assert_has "$(cn_events)" '"result":"pass"' "pass"
}

test_r16d3_play_gap_is_15_s() {
  local v
  v="$( unset CANARY_PLAY_GAP_S; G_RUNMODE=1; . "$KDIR/lib/common.sh"; echo "$CANARY_PLAY_GAP_S" )"
  assert_eq "$v" "15" "g_def CANARY_PLAY_GAP_S"
  # and the code honours it: play 2 does not start before first_start + gap (mono_ms seam)
  r6_at 22:00
  CANARY_PLAY_GAP_S=2
  eval "$(declare -f canary_play_once | sed '1s/canary_play_once/r3_orig_play_once/')"
  R3_STARTS=""
  canary_play_once() { r3_orig_play_once "$@"; local rc=$?; R3_STARTS="$R3_STARTS $P_START"; return $rc; }
  cn_run
  set -- $R3_STARTS
  assert_eq "$(( $2 - $1 >= 2000 ? 1 : 0 ))" "1" "second play starts >= gap after the first"
}

test_r16d3_event_never_shows_null_slot_after_commit() {
  r6_at 22:30
  r3_hook 1 'GUARDIAN_FAKE_NOW="$(ist_epoch 23:30)"'
  cn_run
  assert_not "$(cn_events)" '"slot":null' "slot is not null"
  assert_has "$(cn_events)" '"slot":"pm"' "slot pm"
}

# EXECUTED mutant: the gate before play 2 removed. Cases (a), (b), (e) must then play twice (the assertions above would be red).
test_r16d3_mutant_gate_before_play2_removed() {
  local c cmd at
  for c in a b e; do
    case "$c" in
      a) at=22:30; cmd='r3_clock 22:41' ;;
      b) at=22:00; cmd='echo 5000000000 >"$T/hid"' ;;
      e) at=22:00; cmd='write_status state=paused' ;;
    esac
    r6_at "$at"
    r6_mut 's/canary_play_gate "\$ckey" ||/canary_play_gate "$ckey" || [ "$n" = 2 ] ||/'
    r3_hook 1 "$cmd"
    cn_run
    assert_eq "$(cn_plays)" "2" "mutant ($c): play 2 fires although the gate would fail (the real test expects 1)"
  done
}

# ---- fable additions ----
# play 1 PASSES the band threshold, then a change between the plays aborts play 2: the slot is aborted, never a pass
test_r16d3_play1_pass_then_abort_is_not_a_pass() {
  local ev rb
  r6_at 22:00
  r3_hook 1 'write_status state=paused'
  cn_run
  ev="$(cn_events)"
  assert_has "$ev" '"result":"aborted:recorder_busy"' "aborted:recorder_busy"
  assert_not "$ev" '"result":"pass"' "final result is not pass"
  assert_eq "$(printf '%s' "$ev" | grep -o '"rise_db_band"' | wc -l | tr -d ' ')" "1" "plays has 1 element"
  rb="$(printf '%s' "$ev" | grep -o '"rise_db_band":[0-9.-]*' | head -1 | cut -d: -f2)"
  assert_eq "$(awk -v r="$rb" 'BEGIN { print (r + 0 >= 34.67) ? "ok" : "low " r }')" "ok" "play 1 band rise is pass-level ($rb)"
  assert_has "$ev" '"pass_broadband":true' "play 1 recorded"
  assert_eq "$(cn_plays)" "1" "1 afplay call"
}

# ---- m10: the band statistic, not the broadband one, decides ----
# r3_two_plays <tone hz> <tone rms> <bed hz>: an eligible pm slot where both plays use the same tone; the quiet bed is a sine of <bed hz> at RMS 100
r3_two_plays() {
  r6_at 22:00
  [ -z "${R3_MUT:-}" ] || r6_mut "$R3_MUT"   # r6_at reloads the libs, so a mutant goes in after it
  echo "$2" >"$T/afplay_amp"; echo "$1" >"$T/afplay_hz"; echo "$3" >"$T/afplay_bedhz"
  mk_pcm_tone 100 10 "$3"
  cn_run
}
r3_nums() { printf '%s' "$(cn_events)" | grep -o "\"$1\":[a-z0-9.-]*" | cut -d: -f2 | tr '\n' ' '; }

# A: loud 100 Hz tone: broadband rise >= 32.65 on both plays, band rise < 34.67 -> no_local_rise
test_r16d3_m10_a_loud_out_of_band_tone_is_no_local_rise() {
  r3_two_plays 100 8000 1000
  assert_has "$(cn_events)" '"result":"no_local_rise"' "A: no_local_rise, not pass"
  assert_eq "$(r3_nums pass_broadband)" "true true " "A: pass_broadband true on both plays"
  assert_eq "$(r3_nums rise_db_band | awk '{ print ($1 < 34.67 && $2 < 34.67) ? "below" : "NOT below: " $0 }')" "below" "A: rise_db_band below 34.67 on both plays"
  assert_eq "$(r3_nums rise_db | awk '{ print ($1 >= 32.65 && $2 >= 32.65) ? "above" : "NOT above" }')" "above" "A: broadband rise above 32.65 on both plays"
}

# B: a 100 Hz bed (almost nothing in 1-3 kHz) and a 1 kHz tone of RMS 1500: broadband rise 23.5 dB (< 32.65), band rise tens of dB above the 1 LSB floor (>= 34.67) -> pass
test_r16d3_m10_b_quiet_band_tone_over_low_bed_is_pass() {
  r3_two_plays 1000 1500 100
  assert_has "$(cn_events)" '"result":"pass"' "B: pass"
  assert_eq "$(r3_nums pass_broadband)" "false false " "B: pass_broadband false on both plays"
  assert_eq "$(r3_nums rise_db_band | awk '{ print ($1 >= 34.67 && $2 >= 34.67) ? "above" : "NOT above: " $0 }')" "above" "B: rise_db_band at or above 34.67 on both plays"
  assert_eq "$(r3_nums rise_db | awk '{ print ($1 < 32.65 && $2 < 32.65) ? "below" : "NOT below: " $0 }')" "below" "B: broadband rise below 32.65 on both plays"
}

# EXECUTED m10 mutant (inside the suite): the decision on the broadband rise flips both results
test_r16d3_m10_mutant_decides_on_broadband_flips_a_and_b() {
  R3_MUT='s/awk -v r="\$P_RB" -v t="\$CANARY_BAND_PASS_DB"/awk -v r="$P_RISE" -v t="$CANARY_PASS_DB"/'
  r3_two_plays 100 8000 1000
  assert_has "$(cn_events)" '"result":"pass"' "mutant on A gives pass (the A test expects no_local_rise)"
  r3_two_plays 1000 1500 100
  assert_has "$(cn_events)" '"result":"no_local_rise"' "mutant on B gives no_local_rise (the B test expects pass)"
}

# near the threshold, end to end: band rise about 34.2 dB must FAIL, about 35.2 dB must PASS (both plays), measured against $CANARY_BAND_PASS_DB
test_r16d_near_threshold_34_2_fails_35_2_passes() {
  local rb
  r3_two_plays 1000 5129 1000
  rb="$(r3_nums rise_db_band)"
  assert_has "$(cn_events)" '"result":"no_local_rise"' "34.2 dB: no_local_rise"
  assert_eq "$(awk -v t="$CANARY_BAND_PASS_DB" -v l="$rb" 'BEGIN { split(l, a, " "); print (a[1] < t && a[2] < t && a[1] > t - 1 && a[2] > t - 1) ? "ok" : "bad " l }')" "ok" "34.2 fixture: measured band rise just under the threshold ($rb)"
  r3_two_plays 1000 5754 1000
  rb="$(r3_nums rise_db_band)"
  assert_has "$(cn_events)" '"result":"pass"' "35.2 dB: pass"
  assert_eq "$(awk -v t="$CANARY_BAND_PASS_DB" -v l="$rb" 'BEGIN { split(l, a, " "); print (a[1] >= t && a[2] >= t && a[1] < t + 1 && a[2] < t + 1) ? "ok" : "bad " l }')" "ok" "35.2 fixture: measured band rise just over the threshold ($rb)"
}

