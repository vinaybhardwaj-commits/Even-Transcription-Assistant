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
  export GUARDIAN_CONTROL_SUB_CMD='printf "%s\n\n%s\n" "garbage" "{\"kill\": false, \"modes\": {\"$1\": \"heal\"}}"; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
  start_loops control_loop
  local i=0
  while [ "$i" -lt 40 ] && ! grep -q '"kill": false' "$STATE_DIR/control.last" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
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

# ---- process helpers (tests only ever signal pids they started and recorded in $T/*.pid; lib.sh reap_tracked cleans up) ----
# the loop and helper functions of guardian.sh, for a stand-in main
guardian_funcs() { sed -n '/^MAIN_PID=""/,/^case "\${1:-run}"/p' "$KDIR/bin/guardian.sh" | sed '$d'; }
# fake_sub <name> <secs>: a subscriber command that records the pid of its own sleep in $T/<name>.pid
fake_sub() { printf 'sleep %s & echo $! >>"%s/%s.pid"; wait' "$2" "$T" "$1"; }
# set_subs <ctl secs> <sub secs>: both subscriber commands, each recording its sleep pid
set_subs() { GUARDIAN_CONTROL_SUB_CMD="$(fake_sub ctl "$1")"; GUARDIAN_SUBSCRIBE_CMD="$(fake_sub sub "$2")"; export GUARDIAN_CONTROL_SUB_CMD GUARDIAN_SUBSCRIBE_CMD; }
pid_alive() { local s; s="$(/bin/ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"; [ -n "$s" ] && [ "${s#Z}" = "$s" ]; }
# alive_of <name>: how many recorded pids are still running
alive_of() { local p n=0; for p in $(cat "$T/$1.pid" 2>/dev/null); do pid_alive "$p" && n=$((n + 1)); done; echo "$n"; }
# wait_alive <name> <count> [tries of 0.25 s]
wait_alive() { local i=0; while [ "$i" -lt "${3:-40}" ] && [ "$(alive_of "$1")" != "$2" ]; do sleep 0.25; i=$((i + 1)); done; }
# start_guardian: the real guardian.sh run, in the background; GP = its pid (recorded for cleanup)
start_guardian() { bash "$KDIR/bin/guardian.sh" run >/dev/null 2>&1 & GP=$!; echo "$GP" >>"$T/main.pid"; }
# start_loops <fn>...: a stand-in main (subshell) that runs the named loops under job control, as run() does. LM = its pid.
# LOOP_STDIN = fd to give it as stdin (default 0).
start_loops() {
  ( eval "$(guardian_funcs)"; MAIN_PID="$(exec sh -c 'echo $PPID')"; set -m; for f in "$@"; do "$f" & done; set +m; wait ) <&"${LOOP_STDIN:-0}" >/dev/null 2>&1 &
  LM=$!; echo "$LM" >>"$T/main.pid"
}
# a decoy in a process group of its own (stands for a process that reused a pid the Guardian once knew)
start_decoy() { set -m; sleep 4601 >/dev/null 2>&1 & DECOY=$!; set +m; echo "$DECOY" >>"$T/decoy.pid"; }

# ---- trap ----
test_term_kills_the_subscriber_pipelines() {
  load_libs
  set_subs 4243 4244
  start_guardian
  wait_alive ctl 1; wait_alive sub 1
  assert_eq "$(alive_of ctl)$(alive_of sub)" "11" "both fake subscribers are running"
  kill -TERM "$GP"; wait "$GP" 2>/dev/null
  wait_alive ctl 0 24; wait_alive sub 0 24
  assert_eq "$(alive_of ctl)$(alive_of sub)" "00" "no orphan subscriber process within 6 s of TERM"
}

# ---- R3 ----
test_missing_top_level_kill_is_killed_wherever_a_nested_kill_sits() {
  use_ctl
  ctl_engaged 1 '{"meta": {"kill": false}, "modes": {"opd9": "heal"}}'; assert_rc $? 0 "nested in meta object"
  ctl_engaged 1 '{"modes": {"opd9": "heal"}, "meta": {"kill": false}}'; assert_rc $? 0 "nested in meta after modes"
  ctl_engaged 1 '{"list": [{"kill": false}], "modes": {"opd9": "heal"}}'; assert_rc $? 0 "inside an array of objects"
  ctl_engaged 1 '{"list": ["kill", false], "modes": {"opd9": "heal"}}'; assert_rc $? 0 "kill word inside an array"
  ctl_engaged 1 '{"modes": {"opd9": "heal", "kill": false}}'; assert_rc $? 0 "inside modes"
  ctl_engaged 1 '{"modes": {"opd9": {"kill": false}}}'; assert_rc $? 0 "deep inside modes"
  ctl_engaged 1 '{"modes": {"opd9": "heal"}, "after": {"kill": false}}'; assert_rc $? 0 "in an object after modes"
  ctl_engaged 1 '{"note": "{\"kill\": false}", "modes": {"opd9": "heal"}}'; assert_rc $? 0 "inside a string"
  ctl_engaged 1 '{"note": "x", "kill_switch": false, "modes": {"opd9": "heal"}}'; assert_rc $? 0 "other key that starts with kill"
  ctl_engaged 1 '{"meta": {"kill": false}, "modes": {"opd9": "heal"}, "ts": '"$GUARDIAN_FAKE_NOW"'}'; assert_rc $? 0 "nested kill with a valid ts"
  assert_eq "$(current_mode)" "shadow" "shadow in every missing-kill case"
  ctl_engaged 1 '{"k\u0069ll": false, "modes": {"opd9": "heal"}}'; assert_rc $? 0 "escaped key name"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}} trailing'; assert_rc $? 0 "junk after the object"
  ctl_engaged 1 '{"kill": [false], "modes": {}}'; assert_rc $? 0 "kill as an array"
  ctl_engaged 1 '{"kill": {"x": false}, "modes": {}}'; assert_rc $? 0 "kill as an object"
  ctl_engaged 1 '{"kill": null, "modes": {}}'; assert_rc $? 0 "kill null"
}

test_exact_live_payload_still_clear() {
  use_ctl
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd2\": \"shadow\", \"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "live shape, heal room"
  assert_eq "$(current_mode)" "heal" "live shape gives heal"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd9\": \"shadow\"}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "live shape, shadow room"
  assert_eq "$(current_mode)" "shadow" "live shape gives shadow"
  ctl_engaged 1 "{\"kill\":false,\"modes\":{\"opd9\":\"heal\"},\"ts\":$GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "compact"
  assert_eq "$(current_mode)" "heal" "compact gives heal"
}

test_nested_modes_key_in_meta_is_not_read_as_modes() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "meta": {"modes": {"opd9": "heal"}}, "modes": {}}'; assert_rc $? 1 "clear"
  assert_eq "$(current_mode)" "shadow" "nested modes ignored"
}

test_leading_zero_ts_does_not_crash_and_fails_closed() {
  use_ctl
  local err
  err="$T/err.txt"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": 09}' 2>"$err"; assert_rc $? 0 "ts 09 (a value of 9 is stale)"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": 0123}' 2>>"$err"; assert_rc $? 0 "ts 0123 (stale)"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": 08}' 2>>"$err"; assert_rc $? 0 "ts 08"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": 0$GUARDIAN_FAKE_NOW}" 2>>"$err"; assert_rc $? 1 "a zero-padded current epoch is read as base 10 and is fresh"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": 0x10}' 2>>"$err"; assert_rc $? 0 "hex-looking ts"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": 99999999999999999999}' 2>>"$err"; assert_rc $? 0 "too many digits"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": 1 2}' 2>>"$err"; assert_rc $? 0 "two numbers"
  assert_eq "$(cat "$err")" "" "no bash arithmetic error text"
  # receive epoch (line 1 of control.last) with a leading zero
  rm -f "$STATE_DIR/control_latch"
  { printf '0%s\n' "$((GUARDIAN_FAKE_NOW - 1))"; printf '%s\n' "$HEAL"; } >"$STATE_DIR/control.last"
  flag_fetch 2>"$err"; killswitch_engaged 2>>"$err"; assert_rc $? 1 "zero-padded receive epoch is base 10"
  { printf '09\n%s\n' "$HEAL"; } >"$STATE_DIR/control.last"
  flag_fetch 2>>"$err"; killswitch_engaged 2>>"$err"; assert_rc $? 0 "receive epoch 09 is ancient"
  assert_eq "$(cat "$err")" "" "no arithmetic error from the receive epoch"
}


# ---- orphans: the loops stop by themselves when main is gone ----
test_main_error_exit_leaves_no_subscriber() {
  load_libs
  set_subs 4511 4512
  (
    eval "$(guardian_funcs)"
    flag_poll() { :; }
    tick() { sleep 1.5; exit 3; }   # main dies of an error after the loops are up
    run
  ) >/dev/null 2>&1 &
  local mp=$!
  echo "$mp" >>"$T/main.pid"
  wait_alive ctl 1; wait_alive sub 1
  assert_eq "$(alive_of ctl)$(alive_of sub)" "11" "both fake subscribers are up"
  wait "$mp"; assert_rc $? 3 "main exited through its error path"
  wait_alive ctl 0 24; wait_alive sub 0 24
  assert_eq "$(alive_of ctl)$(alive_of sub)" "00" "no subscriber left within 6 s of main's error exit"
}

test_sigkill_of_main_leaves_no_subscriber() {
  load_libs
  set_subs 4521 4522
  start_guardian
  wait_alive ctl 1; wait_alive sub 1
  assert_eq "$(alive_of ctl)$(alive_of sub)" "11" "both fake subscribers are up"
  # precondition: the loops are NOT in main's process group, so a group kill of main would leave them (the launchd case)
  local mg lg
  mg="$(/bin/ps -o pgid= -p "$GP" | tr -d ' ')"; lg="$(/bin/ps -o pgid= -p "$(head -n1 "$T/ctl.pid")" | tr -d ' ')"
  [ -n "$lg" ] && [ "$mg" != "$lg" ] && ok || fail "loop group [$lg] must differ from main's group [$mg]"
  kill -9 "$GP"; wait "$GP" 2>/dev/null
  wait_alive ctl 0 24; wait_alive sub 0 24
  assert_eq "$(alive_of ctl)$(alive_of sub)" "00" "no subscriber left within 6 s of SIGKILL of main"
}

test_hup_of_main_leaves_no_subscriber() {
  load_libs
  set_subs 4531 4532
  start_guardian
  wait_alive ctl 1; wait_alive sub 1
  kill -HUP "$GP"; wait "$GP" 2>/dev/null
  wait_alive ctl 0 24; wait_alive sub 0 24
  assert_eq "$(alive_of ctl)$(alive_of sub)" "00" "no subscriber left within 6 s of HUP"
}

# A decoy in its own process group stands for any process that reused a pid the Guardian once held. Main sends no signal by pid, and a
# loop signals only its own group, so the decoy must survive TERM, an error exit and SIGKILL of main.
test_decoy_is_never_signalled_on_term_exit_or_sigkill() {
  load_libs
  set_subs 4541 4542
  start_decoy
  start_guardian
  wait_alive ctl 1; wait_alive sub 1
  kill -TERM "$GP"; wait "$GP" 2>/dev/null
  wait_alive ctl 0 24; wait_alive sub 0 24
  pid_alive "$DECOY" && ok || fail "decoy was signalled on TERM"
  : >"$T/ctl.pid"; : >"$T/sub.pid"
  (
    eval "$(guardian_funcs)"
    flag_poll() { :; }
    tick() { sleep 1.5; exit 3; }
    run
  ) >/dev/null 2>&1 &
  local mp=$!; echo "$mp" >>"$T/main.pid"
  wait_alive ctl 1; wait_alive sub 1
  wait "$mp"
  wait_alive ctl 0 24; wait_alive sub 0 24
  pid_alive "$DECOY" && ok || fail "decoy was signalled on the EXIT path"
  : >"$T/ctl.pid"; : >"$T/sub.pid"
  start_guardian
  wait_alive ctl 1; wait_alive sub 1
  kill -9 "$GP"; wait "$GP" 2>/dev/null
  wait_alive ctl 0 24; wait_alive sub 0 24
  assert_eq "$(alive_of ctl)$(alive_of sub)" "00" "loops stopped after SIGKILL"
  pid_alive "$DECOY" && ok || fail "decoy was signalled when main was gone"
}

test_guardian_remembers_no_pid_to_signal() {
  local g="$KDIR/bin/guardian.sh"
  assert_eq "$(grep -cE 'LOOP_PIDS|WATCHDOG|pkill|killall|kill -TERM -- "-' "$g")" "0" "no remembered-pid or pattern kill in guardian.sh"
  assert_eq "$(grep -cE 'kill (-[A-Z]+ )?(-- )?"?\$' "$g")" "0" "no kill of a variable pid or pgid"
}

# ---- stdin ----
test_subscribers_read_eof_not_the_terminal() {
  load_libs
  export GUARDIAN_CONTROL_SUB_CMD='x=unset; read -r x; echo "rc=$? val=[$x]" >"$T/stdin_ctl"; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
  export GUARDIAN_SUBSCRIBE_CMD='x=unset; read -r x; echo "rc=$? val=[$x]" >"$T/stdin_sub"; sleep 30 & echo $! >>"$T/sub.pid"; wait'
  # a stdin that would block, as a terminal would: a fifo held open read-write by this shell
  mkfifo "$T/fifo"; exec 9<>"$T/fifo"
  LOOP_STDIN=9 start_loops control_loop subscriber_loop
  local i=0
  while [ "$i" -lt 30 ] && { [ ! -s "$T/stdin_ctl" ] || [ ! -s "$T/stdin_sub" ]; }; do sleep 0.2; i=$((i + 1)); done
  assert_eq "$(cat "$T/stdin_ctl" 2>/dev/null)" "rc=1 val=[]" "control subscriber: EOF at once"
  assert_eq "$(cat "$T/stdin_sub" 2>/dev/null)" "rc=1 val=[]" "message subscriber: EOF at once"
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  exec 9<&-
}

# ---- R4: parse ----
test_scanner_error_anywhere_is_killed() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "modes": {}, "kill": true}'; assert_rc $? 0 "duplicate kill after modes"
  ctl_engaged 1 '{"kill": false, "modes": {}, "note": "unterminated}'; assert_rc $? 0 "unterminated string"
  ctl_engaged 1 '{"kill": false, "modes": {}, "list": [1, 2}'; assert_rc $? 0 "unbalanced ["
  ctl_engaged 1 '{"kill": false, "modes": {}, "list": [1, 2]]}'; assert_rc $? 0 "extra ]"
  assert_eq "$(current_mode)" "shadow" "shadow after every scanner error"
}

test_missing_colon_is_killed() {
  use_ctl
  ctl_engaged 1 '{"kill" false, "modes": {}}'; assert_rc $? 0 "colon missing after kill"
  ctl_engaged 1 '{"kill": false, "modes" {"opd9": "heal"}}'; assert_rc $? 0 "colon missing after modes"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9" "heal"}}'; assert_rc $? 0 "colon missing inside modes"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal" "opd2": "shadow"}}'; assert_rc $? 0 "comma missing inside modes"
  ctl_engaged 1 '{"kill": false "ts": 1}'; assert_rc $? 0 "comma missing between top-level keys"
  assert_eq "$(current_mode)" "shadow" "shadow in every case"
}

test_modes_read_only_at_the_top_level_and_flat() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "meta": {"modes": {"opd9": "heal"}}}'; assert_rc $? 1 "no top-level modes: clear"
  assert_eq "$(current_mode)" "shadow" "modes nested in meta is not read"
  ctl_engaged 1 '{"kill": false, "meta": {"modes": {"opd9": "heal"}}, "modes": {"opd9": "shadow"}}'; assert_rc $? 1 "clear"
  assert_eq "$(current_mode)" "shadow" "top-level modes wins over a nested one"
  ctl_engaged 1 '{"kill": false, "modes": {"x": {"opd9": "heal"}}}'; assert_rc $? 0 "room nested one level inside modes"
  assert_eq "$(current_mode)" "shadow" "nested room never gives heal"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": {"mode": "heal"}}}'; assert_rc $? 0 "object as a mode value"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": ["heal"]}}'; assert_rc $? 0 "array as a mode value"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal", "opd9": "shadow"}}'; assert_rc $? 0 "room named twice"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}}'; assert_rc $? 1 "flat modes still read"
  assert_eq "$(current_mode)" "heal" "flat heal"
}

test_payload_cap_4096_bytes_before_awk() {
  use_ctl
  local pad t0 t1
  pad="$(head -c 200000 /dev/zero | tr '\0' x)"
  t0="$(perl -MTime::HiRes=time -e 'print time')"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {}, \"pad\": \"$pad\"}"; assert_rc $? 0 "200 KB payload"
  t1="$(perl -MTime::HiRes=time -e 'print time')"
  assert_eq "$(awk -v a="$t0" -v b="$t1" 'BEGIN{print (b - a < 1) ? "fast" : "slow"}')" "fast" "200 KB payload rejected in under 1 s"
  assert_eq "$CTRL_WHY" "unparseable" "reason"
  pad="$(head -c 3000 /dev/zero | tr '\0' x)"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {}, \"pad\": \"$pad\"}"; assert_rc $? 1 "3 KB payload is still read"
  pad="$(head -c 4200 /dev/zero | tr '\0' x)"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {}, \"pad\": \"$pad\"}"; assert_rc $? 0 "4.2 KB payload is over the cap"
}

# ---- R5 ----
# 0 when file $1 holds at least one backslash byte (the editing tool strips backslashes from source, so payloads are built with printf)
has_bs() { [ "$(LC_ALL=C awk 'index($0, sprintf("%c", 92)) { n++ } END { print n + 0 }' "$1")" -ge 1 ]; }

test_escaped_key_payloads_hold_real_backslashes_and_are_killed() {
  use_ctl
  local bs p
  bs="$(printf '\134')"
  p='{"kill": false, "modes": {}, "'"${bs}"'u006bill": true}'
  ctl_engaged 1 "$p"; assert_rc $? 0 "escaped key after kill"
  has_bs "$STATE_DIR/control.last" && ok || fail "control.last holds no backslash byte (escaped key after kill)"; od -c "$STATE_DIR/control.last" >>"$T/od_escaped.txt"
  assert_eq "$(current_mode)" "shadow" "shadow"
  p='{"kill": false, "modes": {}, "k'"${bs}"'u0069ll": true}'
  ctl_engaged 1 "$p"; assert_rc $? 0 "escaped key spelling kill"
  has_bs "$STATE_DIR/control.last" && ok || fail "control.last holds no backslash byte (escaped kill spelling)"; od -c "$STATE_DIR/control.last" >>"$T/od_escaped.txt"
  p='{"kill": false, "modes": {"opd9": "heal"}, "x'"${bs}"'"y": 1}'
  ctl_engaged 1 "$p"; assert_rc $? 0 "escaped quote in a key"
  has_bs "$STATE_DIR/control.last" && ok || fail "control.last holds no backslash byte (escaped quote)"; od -c "$STATE_DIR/control.last" >>"$T/od_escaped.txt"

}

# MAIN_PID empty: the loop does not run (fail closed) and says so in the audit log
test_loop_with_empty_main_pid_does_not_run() {
  load_libs
  set_subs 4611 4612
  ( eval "$(guardian_funcs)"; MAIN_PID=""; control_loop ) </dev/null >/dev/null 2>&1
  assert_rc $? 0 "loop returned at once"
  assert_eq "$(alive_of ctl)" "0" "the subscriber command never started"
  assert_has "$(cat "$AUDIT_LOG" 2>/dev/null)" "MAIN_PID empty" "audit line"
}

# run(): if sh cannot report main's pid (first call prints nothing), MAIN_PID falls back to $$ and the loops still run
test_run_falls_back_to_dollar_dollar_when_main_pid_is_empty() {
  load_libs
  set_subs 4621 4622
  printf '#!/bin/bash\necho x >>"%s/shcalls"\nmkdir "%s/first" 2>/dev/null && exit 0\nexec /bin/sh "$@"\n' "$T" "$T" >"$T/bin/sh"
  chmod +x "$T/bin/sh"
  start_guardian
  wait_alive ctl 1; wait_alive sub 1
  sleep 4
  assert_eq "$(alive_of ctl)$(alive_of sub)" "11" "loops still running with the \$\$ fallback"
  assert_eq "$(wc -l <"$T/shcalls" | tr -d " ")" "3" "fake sh was used for main (empty) and for the two loops"
  kill -TERM "$GP"; wait "$GP" 2>/dev/null
  wait_alive ctl 0 24; wait_alive sub 0 24
  assert_eq "$(alive_of ctl)$(alive_of sub)" "00" "loops stop after TERM"
}

# fake ps: for the parent read (-o ppid=) it prints nothing according to $T/psmode, otherwise it runs the real ps
mk_fake_ps() {
  cat >"$T/psfake" <<'F'
#!/bin/bash
case "$*" in
  *ppid=*)
    n=$(cat "$T/pscount" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$T/pscount"
    case "$(cat "$T/psmode")" in
      dead) exit 0 ;;
      flaky) [ $((n % 3)) -ne 0 ] && exit 0 ;;
    esac ;;
esac
exec /bin/ps "$@"
F
  chmod +x "$T/psfake"
}

test_two_empty_ps_reads_in_a_row_do_not_end_the_loop() {
  load_libs
  set_subs 4631 4632
  mk_fake_ps; echo flaky >"$T/psmode"
  export GUARDIAN_TESTMODE=1 GUARDIAN_PS="$T/psfake"
  start_loops control_loop
  local i=0
  while [ "$i" -lt 60 ] && [ "$(cat "$T/pscount" 2>/dev/null || echo 0)" -lt 8 ]; do sleep 0.25; i=$((i + 1)); done
  assert_eq "$([ "$(cat "$T/pscount")" -ge 8 ] && echo enough)" "enough" "the loop made 8+ parent reads"
  assert_eq "$(alive_of ctl)" "1" "loop survived runs of 2 empty reads that were followed by a good read"
  assert_not "$(cat "$AUDIT_LOG" 2>/dev/null)" "empty ps reads" "no exit audit line"
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
}

test_three_empty_ps_reads_in_a_row_end_the_loop_with_an_audit_line() {
  load_libs
  set_subs 4641 4642
  mk_fake_ps; echo dead >"$T/psmode"
  export GUARDIAN_TESTMODE=1 GUARDIAN_PS="$T/psfake"
  start_loops control_loop
  wait_alive ctl 1 20
  wait_alive ctl 0 40
  assert_eq "$(alive_of ctl)" "0" "loop and its subscriber gone after 3 empty reads"
  assert_has "$(cat "$AUDIT_LOG" 2>/dev/null)" "3 empty ps reads in a row" "audit line written on exit"
  assert_eq "$([ "$(cat "$T/pscount")" -ge 3 ] && echo yes)" "yes" "at least 3 reads were made"
  assert_eq "$([ "$(cat "$T/pscount")" -le 5 ] && echo yes)" "yes" "it did not read forever"
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
}

# GUARDIAN_PS is honoured only in test mode; outside it a fake ps is ignored and /bin/ps is used
test_ps_override_is_ignored_outside_test_mode() {
  load_libs
  set_subs 4651 4652
  mk_fake_ps; echo dead >"$T/psmode"
  unset GUARDIAN_TESTMODE
  export GUARDIAN_PS="$T/psfake"
  start_loops control_loop
  wait_alive ctl 1 20
  sleep 5
  assert_eq "$(alive_of ctl)" "1" "loop still running: the always-empty fake ps was not used"
  assert_eq "$(cat "$T/pscount" 2>/dev/null || echo 0)" "0" "fake ps never called"
  assert_not "$(cat "$AUDIT_LOG" 2>/dev/null)" "empty ps reads" "no exit audit line"
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
}

# ---- R6: after a key only ":", after a value only "," or "}" ----
test_scanner_token_order_is_strict() {
  use_ctl
  ctl_engaged 1 '{"kill" "junk": false, "modes": {"opd9": "heal"}, "ts": '"$GUARDIAN_FAKE_NOW"'}'; assert_rc $? 0 "missing colon then an extra string (the C3 payload)"
  assert_eq "$(current_mode)" "shadow" "that payload gives no heal"
  ctl_engaged 1 '{"kill" "kill": false, "modes": {}}'; assert_rc $? 0 "key key colon"
  ctl_engaged 1 '{"kill": false, "a" "b": 1, "modes": {}}'; assert_rc $? 0 "key key colon on another key"
  ctl_engaged 1 '{"kill": false, "note": "a" "b", "modes": {}}'; assert_rc $? 0 "string string"
  ctl_engaged 1 '{"kill": false, "n": 1 2, "modes": {}}'; assert_rc $? 0 "number number"
  ctl_engaged 1 '{"kill": false, "m": {} {}, "modes": {}}'; assert_rc $? 0 "object object"
  ctl_engaged 1 '{"kill": false, "m": "x" {}, "modes": {}}'; assert_rc $? 0 "string then object"
  ctl_engaged 1 '{"kill": false, "modes": {},}'; assert_rc $? 0 "trailing comma"
  ctl_engaged 1 '{"kill": false,, "modes": {}}'; assert_rc $? 0 "double comma"
  ctl_engaged 1 '{"kill": false, "modes": {}, "x": }'; assert_rc $? 0 "colon without a value before the closing brace"
  ctl_engaged 1 '{"kill": false, "x":, "modes": {}}'; assert_rc $? 0 "colon without a value before a comma"
  ctl_engaged 1 '{"kill":, "modes": {}}'; assert_rc $? 0 "kill with no value"
  ctl_engaged 1 '{"kill": false, "modes": {}, "x": 1 }'; assert_rc $? 1 "spaces before the closing brace are fine"
  ctl_engaged 1 '{ "kill" : false , "modes" : { "opd9" : "heal" } , "ts" : '"$GUARDIAN_FAKE_NOW"' }'; assert_rc $? 1 "generous whitespace is fine"
  assert_eq "$(current_mode)" "heal" "heal for the generous-whitespace live shape"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": '"$GUARDIAN_FAKE_NOW"'}'; assert_rc $? 1 "live shape is clear"
  assert_eq "$(current_mode)" "heal" "live shape gives heal"
}
