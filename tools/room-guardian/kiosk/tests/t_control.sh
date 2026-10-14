#!/bin/bash
# FR1-C1.1: control subscription, control.last, and "no message for 90 s = kill" (fable C4).
# put_ctl <age_s> <payload>: control.last as the control loop would have written it, received <age_s> ago.
put_ctl() {
  mkdir -p "$STATE_DIR"
  { printf '%s\n' "$((GUARDIAN_FAKE_NOW - $1))"; printf '%s\n' "$2"; } >"$STATE_DIR/control.last"
}
use_ctl() { load_libs; export GUARDIAN_CONTROL_SUB_CMD='true'; }
# advance the clock by $1 s, then run the fetch the main loop would run
tick_to() { GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + $1)); flag_fetch; }
OFF='{"kill": false, "modes": {"opd9": "shadow", "opd2": "heal"}}'
HEAL='{"kill": false, "modes": {"opd2": "shadow", "opd9": "heal"}}'

test_fresh_kill_false_not_engaged_mode_per_room() {
  use_ctl
  put_ctl 1 "$OFF"; flag_fetch; killswitch_engaged; assert_rc $? 1 "fresh kill=false clear"
  assert_eq "$(current_mode)" "shadow" "other room's heal key does not count"
  put_ctl 1 "$HEAL"; flag_fetch; killswitch_engaged; assert_rc $? 1 "still clear"
  assert_eq "$(current_mode)" "heal" "this room's heal key"
  put_ctl 1 '{"kill":false,"modes":{}}'; flag_fetch
  assert_eq "$(current_mode)" "shadow" "no key = shadow, compact spacing"
}

test_kill_true_engaged() {
  use_ctl
  put_ctl 1 '{"kill": true, "modes": {"opd9": "heal"}}'; flag_fetch
  killswitch_engaged; assert_rc $? 0 "kill=true engaged"
  assert_eq "$(current_mode)" "shadow" "kill forces shadow"
  put_ctl 1 '{"kill":true,"modes":{"opd9":"heal"}}'; flag_fetch
  killswitch_engaged; assert_rc $? 0 "kill=true compact"
}

test_room_named_kill_cannot_fake_the_flag() {
  use_ctl; export GUARDIAN_ROOM=kill
  put_ctl 1 '{"kill": true, "modes": {"kill": "heal"}}'; flag_fetch
  killswitch_engaged; assert_rc $? 0 "kill=true wins"
}

test_89_s_clear_91_s_engaged_then_fresh_clears() {
  use_ctl
  put_ctl 0 "$HEAL"; flag_fetch
  tick_to 89; killswitch_engaged; assert_rc $? 1 "89 s old: clear"
  assert_eq "$(current_mode)" "heal" "89 s old: heal allowed"
  tick_to 2;  killswitch_engaged; assert_rc $? 0 "91 s old: engaged"
  assert_eq "$(current_mode)" "shadow" "91 s old: shadow"
  put_ctl 0 "$HEAL"; flag_fetch; killswitch_engaged; assert_rc $? 1 "fresh kill=false clears"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" 'ok -> unreachable:stale' "stale audited"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" 'unreachable:stale -> on:ok' "recovery audited"
}

test_engaged_within_90_s_plus_one_fetch_without_a_fetch() {
  use_ctl
  put_ctl 0 "$HEAL"; flag_fetch
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 91)); FLAG_MAX_AGE_S=1000
  killswitch_engaged; assert_rc $? 0 "stale engages even on a cached 'on'"
}

test_stale_then_fresh_kill_true_stays_engaged() {
  use_ctl
  put_ctl 0 "$HEAL"; flag_fetch; tick_to 120
  killswitch_engaged; assert_rc $? 0 "stale"
  put_ctl 0 '{"kill": true, "modes": {}}'; flag_fetch
  killswitch_engaged; assert_rc $? 0 "fresh kill=true still engaged"
}

test_garbage_empty_missing_engaged() {
  use_ctl
  put_ctl 1 'not json at all'; flag_fetch; killswitch_engaged; assert_rc $? 0 "garbage"
  put_ctl 1 '{"modes": {"opd9": "heal"}}'; flag_fetch; killswitch_engaged; assert_rc $? 0 "no kill field"
  put_ctl 1 '{"kill": "false"}'; flag_fetch; killswitch_engaged; assert_rc $? 0 "kill as string"
  put_ctl 1 '{"kill": false'; flag_fetch; killswitch_engaged; assert_rc $? 0 "truncated"
  : >"$STATE_DIR/control.last"; flag_fetch; killswitch_engaged; assert_rc $? 0 "empty file"
  printf 'abc\n%s\n' "$OFF" >"$STATE_DIR/control.last"; flag_fetch; killswitch_engaged; assert_rc $? 0 "bad epoch"
  printf '%s\n%s\n' "$((GUARDIAN_FAKE_NOW + 3600))" "$OFF" >"$STATE_DIR/control.last"; flag_fetch; killswitch_engaged; assert_rc $? 0 "epoch in the future"
  rm -f "$STATE_DIR/control.last"; flag_fetch; killswitch_engaged; assert_rc $? 0 "missing file"
  assert_eq "$(current_mode)" "shadow" "shadow"
}

test_per_kiosk_flag_still_wins() {
  use_ctl
  put_ctl 1 "$HEAL"; flag_fetch; touch "$FLAG_DIR/heal-off"
  killswitch_engaged; assert_rc $? 0 "heal-off file"
}

test_old_flag_cmd_path_unchanged_when_sub_cmd_unset() {
  load_libs; unset GUARDIAN_CONTROL_SUB_CMD; GUARDIAN_CONTROL_SUB_CMD=""
  put_ctl 1 "$HEAL"   # must be ignored
  go_heal; killswitch_engaged; assert_rc $? 1 "flag cmd path: clear"
  assert_eq "$(current_mode)" "heal" "flag cmd path: heal"
  printf 'fleet=off\n' >"$T/flagout"; flag_fetch; killswitch_engaged; assert_rc $? 0 "flag cmd path: off"
  assert_eq "$FLAG_FETCH_S" "10" "new default fetch period"
  assert_eq "$FLAG_MAX_AGE_S" "30" "new default cache age"
  assert_eq "$CONTROL_STALE_S" "90" "stale limit"
}

test_heal_action_while_stale_is_not_executed() {
  load_libs; export GUARDIAN_CONTROL_SUB_CMD='true'
  mk_tcc 0; write_status mic_state=denied capture_open=false state=mic_denied; touch "$T/boot_ok"
  put_ctl 0 "$HEAL"; flag_fetch; collect_all
  tick_to 120
  heal_tcc
  assert_eq "$(tcc_val)" "0" "row untouched while stale"
  assert_not "$(cat "$CALLS")" "tcc-heal\|coreaudiod-kill\|pmset-baseline\|tcc-prune" "no mutating root verb"
  assert_not "$(cat "$CALLS")" "launchctl boot" "no restart"
  assert_has "$(events)" '"result":"WOULD-DO' "observe and report only"
  recorder_restart; assert_not "$(cat "$CALLS")" "launchctl boot" "recorder_restart blocked too"
}

test_control_store_is_atomic() {
  load_libs
  eval "$(sed -n '/^control_store()/,/^}/p' "$KDIR/bin/guardian.sh")"
  local i bad=0 pid n
  control_store "$OFF"
  ( i=0; while [ "$i" -lt 150 ]; do control_store "$HEAL"; control_store "$OFF"; i=$((i + 1)); done ) &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    n="$(wc -l <"$STATE_DIR/control.last" 2>/dev/null | tr -d ' ')"
    [ "$n" = "2" ] || bad=$((bad + 1))
  done
  wait "$pid"
  assert_eq "$bad" "0" "no partial file ever visible"
  assert_eq "$(find "$STATE_DIR" -name 'control.last.tmp*' | wc -l | tr -d ' ')" "0" "no tmp left behind"
}

test_control_loop_writes_control_last() {
  load_libs
  eval "$(sed -n '/^control_store()/,/^}/p;/^control_loop()/,/^}/p' "$KDIR/bin/guardian.sh")"
  export GUARDIAN_CONTROL_SUB_CMD='printf "%s\n\n%s\n" "garbage" "{\"kill\": false, \"modes\": {\"$1\": \"heal\"}}"; sleep 30'
  control_loop & local pid=$! i=0
  while [ "$i" -lt 40 ] && ! grep -q '"kill": false' "$STATE_DIR/control.last" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  assert_eq "$(sed -n '1p' "$STATE_DIR/control.last")" "$GUARDIAN_FAKE_NOW" "line 1 is the receive epoch"
  assert_has "$(sed -n '2p' "$STATE_DIR/control.last")" '"opd9": "heal"' "line 2 is the last payload, room passed as \$1"
  flag_fetch; killswitch_engaged; assert_rc $? 1 "loop output drives the switch"
  assert_eq "$(current_mode)" "heal" "mode from the loop output"
}
