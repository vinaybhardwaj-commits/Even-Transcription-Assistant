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

# ---- R2 ----
# ctl_engaged <age> <payload>: 0 when the switch is engaged for that control.last
ctl_engaged() { rm -f "$STATE_DIR/control_latch"; put_ctl "$1" "$2"; flag_fetch; killswitch_engaged; }

test_top_level_kill_only_fail_closed() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "meta": {"kill": true}, "modes": {}}'; assert_rc $? 0 "nested meta kill"
  ctl_engaged 1 '{"kill": false, "meta": {"kill": false}, "modes": {}}'; assert_rc $? 0 "nested meta kill=false is still a second kill key"
  ctl_engaged 1 '{"kill": false, "kill": false, "modes": {}}'; assert_rc $? 0 "duplicate kill"
  ctl_engaged 1 '{"kill": true, "kill": false, "modes": {}}'; assert_rc $? 0 "duplicate kill, true first"
  ctl_engaged 1 '{"note": "\"kill\": false", "modes": {}}'; assert_rc $? 0 "kill only inside a string"
  ctl_engaged 1 '{"kill": false, "note": "kill", "modes": {}}'; assert_rc $? 0 "kill word as a value next to the real key"
  ctl_engaged 1 '{"kill": falsey, "modes": {}}'; assert_rc $? 0 "falsey"
  ctl_engaged 1 '{"kill": falsetrue, "modes": {}}'; assert_rc $? 0 "falsetrue"
  ctl_engaged 1 '"kill": false, "modes": {}}'; assert_rc $? 0 "missing opening brace"
  ctl_engaged 1 '{"kill": false, "modes": {}'; assert_rc $? 0 "missing closing brace"
  ctl_engaged 1 '{"modes": {"kill": false}}'; assert_rc $? 0 "kill only inside modes"
  ctl_engaged 1 '{"kill": false, "modes": {}, "modes": {}}'; assert_rc $? 0 "duplicate modes"
  ctl_engaged 1 '{"modes": {"opd9": "heal"}, "kill": false}'; assert_rc $? 1 "order does not matter"
  ctl_engaged 1 '{"kill":false,"modes":{"opd9":"heal"}}'; assert_rc $? 1 "compact spacing"
}

test_heal_to_shadow_takes_effect_without_a_fetch() {
  use_ctl
  put_ctl 1 "$HEAL"; flag_fetch
  assert_eq "$(current_mode)" "heal" "heal"
  put_ctl 1 "$OFF"   # no flag_fetch
  assert_eq "$(current_mode)" "shadow" "shadow at once, cache still says heal"
  put_ctl 1 "$HEAL"; assert_eq "$(current_mode)" "heal" "and back"
  put_ctl 1 '{"kill": true, "modes": {"opd9": "heal"}}'
  assert_eq "$(current_mode)" "shadow" "kill at once"
}

test_stale_latches_through_a_clock_step_back() {
  use_ctl
  put_ctl 0 "$HEAL"; flag_fetch
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 120)); flag_fetch; killswitch_engaged; assert_rc $? 0 "stale"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW - 100)); flag_fetch   # clock steps back: the old message looks 20 s old
  killswitch_engaged; assert_rc $? 0 "still engaged after the clock steps back"
  assert_eq "$(current_mode)" "shadow" "shadow"
  put_ctl 0 "$HEAL"; flag_fetch; killswitch_engaged; assert_rc $? 1 "a new message (new receive epoch) clears it"
}

test_receive_epoch_in_the_future_is_killed() {
  use_ctl
  printf '%s\n%s\n' "$((GUARDIAN_FAKE_NOW + 3))" "$HEAL" >"$STATE_DIR/control.last"; flag_fetch
  killswitch_engaged; assert_rc $? 0 "3 s ahead"
  printf '%s\n%s\n' "$((GUARDIAN_FAKE_NOW + 2))" "$HEAL" >"$STATE_DIR/control.last"; flag_fetch
  killswitch_engaged; assert_rc $? 1 "2 s ahead is tolerated"
}

# ---- ts (publish epoch from the Mini) ----
ts_payload() { printf '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}' "$1"; }

test_ts_absent_falls_back_to_receive_age() {
  use_ctl
  ctl_engaged 1 "$HEAL"; assert_rc $? 1 "no ts, fresh"
  ctl_engaged 91 "$HEAL"; assert_rc $? 0 "no ts, receive age 91"
}

test_ts_fresh_clear_old_engaged_replay_engaged() {
  use_ctl
  ctl_engaged 1 "$(ts_payload "$GUARDIAN_FAKE_NOW")"; assert_rc $? 1 "ts now"
  assert_eq "$(current_mode)" "heal" "heal with ts"
  ctl_engaged 1 "$(ts_payload $((GUARDIAN_FAKE_NOW - 90)))"; assert_rc $? 1 "ts 90 s old"
  ctl_engaged 1 "$(ts_payload $((GUARDIAN_FAKE_NOW - 91)))"; assert_rc $? 0 "replay: fresh receive, ts 91 s old"
  assert_eq "$(current_mode)" "shadow" "replay: shadow"
  ctl_engaged 1 "$(ts_payload 1000)"; assert_rc $? 0 "replay of a very old message"
  ctl_engaged 95 "$(ts_payload "$GUARDIAN_FAKE_NOW")"; assert_rc $? 0 "ts fresh but receive age 95: receive age wins"
}

test_ts_future_skew() {
  use_ctl
  ctl_engaged 1 "$(ts_payload $((GUARDIAN_FAKE_NOW + 30)))"; assert_rc $? 1 "30 s ahead tolerated"
  ctl_engaged 1 "$(ts_payload $((GUARDIAN_FAKE_NOW + 31)))"; assert_rc $? 0 "31 s ahead killed"
}

test_ts_malformed_or_duplicated_is_killed() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": "123"}'; assert_rc $? 0 "ts as string"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": 12.5}'; assert_rc $? 0 "ts float"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": -5}'; assert_rc $? 0 "ts negative"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": null}'; assert_rc $? 0 "ts null"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": }'; assert_rc $? 0 "ts empty"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {}, \"ts\": $GUARDIAN_FAKE_NOW, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 0 "duplicate ts"
  ctl_engaged 1 "{\"kill\": false, \"meta\": {\"ts\": $GUARDIAN_FAKE_NOW}, \"modes\": {}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 0 "nested ts"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {}, \"ts\": ${GUARDIAN_FAKE_NOW}x}"; assert_rc $? 0 "ts with trailing junk"
}

test_rooms_named_ts_and_kill_inside_modes_are_not_read() {
  use_ctl
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"ts\": \"heal\", \"kill\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "keys inside modes ignored, real ones used"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"ts\": \"heal\", \"kill\": \"heal\"}, \"ts\": $((GUARDIAN_FAKE_NOW - 200))}"; assert_rc $? 0 "real old ts still stale"
  ctl_engaged 1 '{"kill": true, "modes": {"ts": "heal", "kill": "heal"}, "ts": 1}'; assert_rc $? 0 "real kill=true wins"
  export GUARDIAN_ROOM=ts
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"ts\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "room named ts"
  assert_eq "$(current_mode)" "heal" "room named ts gets its mode"
}

# ---- trap ----
test_term_kills_the_subscriber_pipelines() {
  load_libs
  local gp i=0 left
  export GUARDIAN_CONTROL_SUB_CMD='sleep 4243 | cat' GUARDIAN_SUBSCRIBE_CMD='sleep 4244 | cat'
  bash "$KDIR/bin/guardian.sh" run >/dev/null 2>&1 &
  gp=$!
  while [ "$i" -lt 30 ] && [ "$(/bin/ps -axo command | grep -c '^sleep 424[34]$')" -lt 2 ]; do sleep 0.2; i=$((i + 1)); done
  assert_eq "$(/bin/ps -axo command | grep -c '^sleep 424[34]$')" "2" "both fake subscribers are running"
  kill -TERM "$gp"; i=0
  while [ "$i" -lt 50 ] && kill -0 "$gp" 2>/dev/null; do sleep 0.2; i=$((i + 1)); done
  sleep 0.5
  left="$(/bin/ps -axo command | grep -c '^sleep 424[34]$')"
  /usr/bin/pkill -f 'sleep 424[34]' 2>/dev/null
  assert_eq "$left" "0" "no orphan subscriber process after TERM"
  kill -0 "$gp" 2>/dev/null && { kill -9 "$gp"; fail "guardian did not exit on TERM"; } || ok
}
