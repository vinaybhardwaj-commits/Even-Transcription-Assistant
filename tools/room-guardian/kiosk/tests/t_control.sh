#!/bin/bash
# shellcheck disable=SC2059
# FR1-C1.1: control subscription, control.last, and "no message for 90 s = kill" (fable C4).
# put_ctl <age_s> <payload>: control.last as the control loop would have written it, received <age_s> ago.
put_ctl() {
  mkdir -p "$STATE_DIR"
  { printf '%s\n' "$((GUARDIAN_FAKE_NOW - $1))"; printf '%s\n' "${2//@TS@/$((GUARDIAN_FAKE_NOW - $1))}"; } >"$STATE_DIR/control.last"
}
use_ctl() { load_libs; export GUARDIAN_CONTROL_SUB_CMD='true'; }
# advance the clock by $1 s, then run the fetch the main loop would run
tick_to() { GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + $1)); flag_fetch; }
OFF='{"kill": false, "modes": {"opd2": "heal", "opd9": "shadow"}, "ts": @TS@}'
HEAL='{"kill": false, "modes": {"opd2": "shadow", "opd9": "heal"}, "ts": @TS@}'

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
  export GUARDIAN_CONTROL_SUB_CMD='printf "%s\n\n%s\n" "garbage" "{\"kill\": false, \"modes\": {\"$1\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}"; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
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
  ctl_engaged 1 '{"modes": {"opd9": "heal"}, "kill": false}'; assert_rc $? 0 "top-level order is the Mini's order only"
  ctl_engaged 1 '{"kill":false,"modes":{"opd9":"heal"}}'; assert_rc $? 0 "compact spacing is not the Mini's form"
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
  printf '%s\n%s\n' "$((GUARDIAN_FAKE_NOW + 3))" "${HEAL//@TS@/$GUARDIAN_FAKE_NOW}" >"$STATE_DIR/control.last"; flag_fetch
  killswitch_engaged; assert_rc $? 0 "3 s ahead"
  printf '%s\n%s\n' "$((GUARDIAN_FAKE_NOW + 2))" "${HEAL//@TS@/$GUARDIAN_FAKE_NOW}" >"$STATE_DIR/control.last"; flag_fetch
  killswitch_engaged; assert_rc $? 1 "2 s ahead is tolerated"
}

# ---- ts (publish epoch from the Mini) ----
ts_payload() { printf '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}' "$1"; }

test_ts_absent_is_killed_and_receive_age_still_applies() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}}'; assert_rc $? 0 "no ts at all is killed"
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
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"kill\": \"heal\", \"ts\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "keys inside modes ignored, real ones used"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"kill\": \"heal\", \"ts\": \"heal\"}, \"ts\": $((GUARDIAN_FAKE_NOW - 200))}"; assert_rc $? 0 "real old ts still stale"
  ctl_engaged 1 '{"kill": true, "modes": {"ts": "heal", "kill": "heal"}, "ts": 1}'; assert_rc $? 0 "real kill=true wins"
  export GUARDIAN_ROOM=ts
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"ts\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "room named ts"
  assert_eq "$(current_mode)" "heal" "room named ts gets its mode"
}

# ---- process helpers (tests only ever signal pids they started and recorded in $T/*.pid; lib.sh reap_tracked cleans up) ----
# the loop and helper functions of guardian.sh, for a stand-in main
guardian_funcs() { sed -n '/^MAIN_PID=""/,/^# check: /p' "$KDIR/bin/guardian.sh" | sed '$d'; }
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
# (a stand-in main in a subshell: guardian.sh run itself reads no environment, R12, so the environment-driven loop tests drive its functions.)
start_guardian() {
  { printf '#!/bin/bash\n'; for f in common collect killswitch faulttree heal probe canary; do printf '. "%s/lib/%s.sh"\n' "$KDIR" "$f"; done
    printf 'mkdir -p "$STATE_DIR" "$FLAG_DIR"\n'; guardian_funcs; printf 'run\n'; } >"$T/gmain.sh"
  bash "$T/gmain.sh" >/dev/null 2>&1 & GP=$!; echo "$GP" >>"$T/main.pid"
}
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
  ctl_engaged 1 "{\"kill\":false,\"modes\":{\"opd9\":\"heal\"},\"ts\":$GUARDIAN_FAKE_NOW}"; assert_rc $? 0 "compact is not the Mini's form"
  assert_eq "$(current_mode)" "shadow" "compact gives no heal"
}

test_nested_modes_key_in_meta_is_not_read_as_modes() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "meta": {"modes": {"opd9": "heal"}}, "modes": {}}'; assert_rc $? 0 "clear"
  assert_eq "$(current_mode)" "shadow" "nested modes ignored"
}

test_leading_zero_ts_does_not_crash_and_fails_closed() {
  use_ctl
  local err
  err="$T/err.txt"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": 09}' 2>"$err"; assert_rc $? 0 "ts 09 (a value of 9 is stale)"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": 0123}' 2>>"$err"; assert_rc $? 0 "ts 0123 (stale)"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": 08}' 2>>"$err"; assert_rc $? 0 "ts 08"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": 0$GUARDIAN_FAKE_NOW}" 2>>"$err"; assert_rc $? 0 "a zero-padded ts is not canonical"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": 0x10}' 2>>"$err"; assert_rc $? 0 "hex-looking ts"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": 99999999999999999999}' 2>>"$err"; assert_rc $? 0 "too many digits"
  ctl_engaged 1 '{"kill": false, "modes": {}, "ts": 1 2}' 2>>"$err"; assert_rc $? 0 "two numbers"
  assert_eq "$(cat "$err")" "" "no bash arithmetic error text"
  # receive epoch (line 1 of control.last) with a leading zero
  rm -f "$STATE_DIR/control_latch"
  { printf '0%s\n' "$((GUARDIAN_FAKE_NOW - 1))"; printf '%s\n' "$HEAL"; } >"$STATE_DIR/control.last"
  flag_fetch 2>"$err"; killswitch_engaged 2>>"$err"; assert_rc $? 0 "zero-padded receive epoch is not canonical"
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
  ctl_engaged 1 '{"kill": false, "meta": {"modes": {"opd9": "heal"}}}'; assert_rc $? 0 "no top-level modes: clear"
  assert_eq "$(current_mode)" "shadow" "modes nested in meta is not read"
  ctl_engaged 1 '{"kill": false, "meta": {"modes": {"opd9": "heal"}}, "modes": {"opd9": "shadow"}}'; assert_rc $? 0 "clear"
  assert_eq "$(current_mode)" "shadow" "top-level modes wins over a nested one"
  ctl_engaged 1 '{"kill": false, "modes": {"x": {"opd9": "heal"}}}'; assert_rc $? 0 "room nested one level inside modes"
  assert_eq "$(current_mode)" "shadow" "nested room never gives heal"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": {"mode": "heal"}}}'; assert_rc $? 0 "object as a mode value"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": ["heal"]}}'; assert_rc $? 0 "array as a mode value"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal", "opd9": "shadow"}}'; assert_rc $? 0 "room named twice"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'; assert_rc $? 1 "flat modes still read"
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
  ctl_engaged 1 "$(gen_payload 40 60)"; assert_rc $? 1 "3 KB payload is still read"
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
  ctl_engaged 1 '{"kill": false, "modes": {}, "x": 1 }'; assert_rc $? 0 "spaces before the closing brace are not the Mini form"
  ctl_engaged 1 '{ "kill" : false , "modes" : { "opd9" : "heal" } , "ts" : '"$GUARDIAN_FAKE_NOW"' }'; assert_rc $? 0 "generous whitespace is not the Mini form"
  assert_eq "$(current_mode)" "shadow" "no heal from generous whitespace"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": '"$GUARDIAN_FAKE_NOW"'}'; assert_rc $? 1 "live shape is clear"
  assert_eq "$(current_mode)" "heal" "live shape gives heal"
}

# ---- R7: one canonical form, everything else killed ----
# gen_payload <rooms> <name length>: a canonical payload built by hand, ts = now. Room 1 is opd9 = heal.
gen_payload() {
  local n="$1" len="$2" i m="" name
  for i in $(seq 1 "$n"); do
    if [ "$i" = 1 ]; then name="opd9"; else name="$(printf 'r%02d' "$i" | head -c "$len")"; name="$(printf '%s%s' "$name" "$(head -c $((len - ${#name})) /dev/zero | tr '\0' x)")"; fi
    [ -n "$m" ] && m="$m, "
    m="$m\"$name\": \"$([ "$i" = 1 ] && echo heal || echo shadow)\""
  done
  printf '{"kill": false, "modes": {%s}, "ts": %s}' "$m" "$GUARDIAN_FAKE_NOW"
}

# canon <kill> <rooms-json-pairs...> via python3 json.dumps(sort_keys=True), default separators (test-only use of python3)
canon() { # kill ts room=mode ...
  python3 -I -c '
import json, sys
kill = sys.argv[1] == "true"
ts = int(sys.argv[2])
modes = dict(a.split("=", 1) for a in sys.argv[3:])
sys.stdout.write(json.dumps({"kill": kill, "modes": modes, "ts": ts}, sort_keys=True))
' "$@"
}

test_python_canonical_payloads_are_accepted_and_read_exactly() {
  use_ctl
  local p i args
  p="$(canon false "$GUARDIAN_FAKE_NOW")"; assert_eq "$p" "{\"kill\": false, \"modes\": {}, \"ts\": $GUARDIAN_FAKE_NOW}" "python form of 0 rooms"
  ctl_engaged 1 "$p"; assert_rc $? 1 "0 rooms clear"; assert_eq "$(current_mode)" "shadow" "0 rooms = shadow"
  p="$(canon false "$GUARDIAN_FAKE_NOW" opd9=heal)"; ctl_engaged 1 "$p"; assert_rc $? 1 "1 room heal clear"; assert_eq "$(current_mode)" "heal" "1 room heal"
  p="$(canon false "$GUARDIAN_FAKE_NOW" opd9=shadow)"; ctl_engaged 1 "$p"; assert_rc $? 1 "1 room shadow clear"; assert_eq "$(current_mode)" "shadow" "1 room shadow"
  p="$(canon true "$GUARDIAN_FAKE_NOW" opd9=heal)"; ctl_engaged 1 "$p"; assert_rc $? 0 "kill true with heal = killed"; assert_eq "$(current_mode)" "shadow" "kill true = shadow"
  p="$(canon false "$GUARDIAN_FAKE_NOW" opd2=heal)"; ctl_engaged 1 "$p"; assert_rc $? 1 "room absent clear"; assert_eq "$(current_mode)" "shadow" "room absent = shadow"
  args=(); for i in 1 2 3 4 5; do args+=("opd$((i + 10))=heal"); done; args+=(opd9=heal)
  p="$(canon false "$GUARDIAN_FAKE_NOW" "${args[@]}")"; ctl_engaged 1 "$p"; assert_rc $? 1 "5+1 rooms clear"; assert_eq "$(current_mode)" "heal" "heal among 6 rooms"
  args=(); for i in $(seq 1 63); do args+=("room-$i=shadow"); done; args+=(opd9=heal)
  p="$(canon false "$GUARDIAN_FAKE_NOW" "${args[@]}")"; ctl_engaged 1 "$p"; assert_rc $? 1 "64 rooms clear"; assert_eq "$(current_mode)" "heal" "heal among 64 rooms"
  args=(); for i in $(seq 1 64); do args+=("room-$i=shadow"); done; args+=(opd9=heal)
  p="$(canon false "$GUARDIAN_FAKE_NOW" "${args[@]}")"; ctl_engaged 1 "$p"; assert_rc $? 0 "65 rooms killed"
  assert_eq "$(current_mode)" "shadow" "65 rooms = shadow"
  p="$(canon true "$GUARDIAN_FAKE_NOW" "${args[@]}")"; ctl_engaged 1 "$p"; assert_rc $? 0 "65 rooms with kill true killed"
}

test_4097_bytes_killed_and_cap_edge() {
  use_ctl
  local p
  ctl_engaged 1 "$(gen_payload 40 60)"; assert_rc $? 1 "about 3 KB canonical is read"
  assert_eq "$(current_mode)" "heal" "heal in a 40-room payload"
  p="$(gen_payload 60 64)"; ctl_engaged 1 "$p"; assert_rc $? 0 "over 4096 bytes killed"
  assert_eq "$([ "$(wc -c <"$STATE_DIR/control.last" | tr -d ' ')" -gt 4096 ] && echo over)" "over" "the file really is over 4096 bytes"
}

# special bytes are built with printf octal and proven present in the file
has_byte() { # <file> <hex byte, two digits>
  LC_ALL=C od -An -v -tx1 "$1" | tr -s ' ' '\n' | grep -qx "$2"
}
write_raw() { # <receive age> <printf format for the payload line> [args]: control.last from raw bytes
  local age="$1" fmt="$2"; shift 2
  { printf '%s\n' "$((GUARDIAN_FAKE_NOW - age))"; printf "$fmt" "$@"; printf '\n'; } >"$STATE_DIR/control.last"
}
raw_engaged() { rm -f "$STATE_DIR/control_latch"; flag_fetch; killswitch_engaged; }

test_special_byte_payloads_are_killed() {
  use_ctl
  local ts="$GUARDIAN_FAKE_NOW" ok_p
  ok_p='{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}'
  write_raw 1 "$ok_p" "$ts"; raw_engaged; assert_rc $? 1 "control: the same bytes without a trick are clear"
  write_raw 1 "\001$ok_p" "$ts"; has_byte "$STATE_DIR/control.last" 01 && ok || fail "no 0x01 in file"; raw_engaged; assert_rc $? 0 "0x01 prefix"
  write_raw 1 "\001{\"kill\": true, \"modes\": {}, \"ts\": %s}\001$ok_p" "$ts" ; raw_engaged; assert_rc $? 0 "0x01 record separator splice"
  write_raw 1 '{"kill": false, "mo\000des": {"opd9": "heal"}, "ts": %s}' "$ts"; has_byte "$STATE_DIR/control.last" 00 && ok || fail "no NUL in file"; raw_engaged; assert_rc $? 0 "NUL inside a key"
  write_raw 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\000' "$ts"; has_byte "$STATE_DIR/control.last" 00 && ok || fail "no trailing NUL"; raw_engaged; assert_rc $? 0 "NUL at the end of the line"
  write_raw 1 '{"kill": false,\t"modes": {"opd9": "heal"}, "ts": %s}' "$ts"; has_byte "$STATE_DIR/control.last" 09 && ok || fail "no tab"; raw_engaged; assert_rc $? 0 "a tab"
  write_raw 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\r' "$ts"; has_byte "$STATE_DIR/control.last" 0d && ok || fail "no CR"; raw_engaged; assert_rc $? 0 "CRLF"
  write_raw 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\377' "$ts"; has_byte "$STATE_DIR/control.last" ff && ok || fail "no 0xFF"; raw_engaged; assert_rc $? 0 "a high byte"
  write_raw 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\177' "$ts"; has_byte "$STATE_DIR/control.last" 7f && ok || fail "no DEL"; raw_engaged; assert_rc $? 0 "DEL"
  write_raw 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\033' "$ts"; has_byte "$STATE_DIR/control.last" 1b && ok || fail "no ESC"; raw_engaged; assert_rc $? 0 "ESC"
  # three lines, no final newline, a blank line
  { printf '%s\n' "$((ts - 1))"; printf "$ok_p\n" "$ts"; printf 'x\n'; } >"$STATE_DIR/control.last"; raw_engaged; assert_rc $? 0 "a third line"
  { printf '%s\n' "$((ts - 1))"; printf "$ok_p" "$ts"; } >"$STATE_DIR/control.last"; raw_engaged; assert_rc $? 0 "no final newline"
  { printf '%s\n\n' "$((ts - 1))"; printf "$ok_p\n" "$ts"; } >"$STATE_DIR/control.last"; raw_engaged; assert_rc $? 0 "blank line between"
  { printf '%s\n' "$((ts - 1))"; printf "$ok_p\n" "$ts"; } >"$STATE_DIR/control.last"; raw_engaged; assert_rc $? 1 "control: two clean lines are clear again"
  { printf '%s\000\n' "$((ts - 1))"; printf "$ok_p\n" "$ts"; } >"$STATE_DIR/control.last"; raw_engaged; assert_rc $? 0 "NUL in the receive line"
  assert_eq "$(current_mode)" "shadow" "shadow after a killed payload"
}

test_every_earlier_bypass_shape_is_killed() {
  use_ctl
  local n=0 p now="$GUARDIAN_FAKE_NOW" bs
  bs="$(printf '\134')"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    p="${p//@TS@/$now}"; n=$((n + 1))
    ctl_engaged 1 "$p"; assert_rc $? 0 "bypass shape $n: $p"
  done <<'LIST'
{"kill": false, "kill": false, "modes": {}, "ts": @TS@}
{"kill": false, "modes": {}, "kill": true, "ts": @TS@}
{"kill": false, "modes": {}, "ts": @TS@, "kill": true}
{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@, "ts": 1}
{"kill": false, "modes": {}, "modes": {"opd9": "heal"}, "ts": @TS@}
{"kill": false, "modes": {}, "note": "unterminated, "ts": @TS@}
{"kill": false, "modes": {}, "list": [1, 2}, "ts": @TS@}
{"kill": false, "modes": {}, "list": [1, 2]], "ts": @TS@}
{"kill": false, "modes": {}, "list": {1, 2], "ts": @TS@}
{"kill" "junk": false, "modes": {"opd9": "heal"}, "ts": @TS@}
{"kill" "kill": false, "modes": {}, "ts": @TS@}
{"kill" false, "modes": {}, "ts": @TS@}
{"kill": false, "modes" {"opd9": "heal"}, "ts": @TS@}
{"kill": false, "modes": {"opd9" "heal"}, "ts": @TS@}
{"kill": false, "modes": {"opd9": "heal" "opd2": "shadow"}, "ts": @TS@}
{"kill": false, "modes": {"x": {"opd9": "heal"}}, "ts": @TS@}
{"kill": false, "modes": {"opd9": {"mode": "heal"}}, "ts": @TS@}
{"kill": false, "modes": {"opd9": ["heal"]}, "ts": @TS@}
{"kill": false, "meta": {"kill": true}, "modes": {}, "ts": @TS@}
{"kill": false, "meta": {"modes": {"opd9": "heal"}}, "modes": {}, "ts": @TS@}
{"meta": {"kill": false}, "modes": {"opd9": "heal"}, "ts": @TS@}
{"modes": {"opd9": "heal"}, "ts": @TS@}
{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@,}
{"kill": false, "modes": {"opd9": "heal"},, "ts": @TS@}
{"kill": false, "modes": {},, "ts": @TS@}
{"kill": false, "modes": {"opd9": "heal",}, "ts": @TS@}
{"kill": false, "modes": {}, "x": , "ts": @TS@}
{"kill": false, "modes": {"opd9": "heal"}, "ts": }
{"kill": falsey, "modes": {}, "ts": @TS@}
{"kill": false , "modes": {}, "ts": @TS@}
{"kill": null, "modes": {}, "ts": @TS@}
{"kill": [false], "modes": {}, "ts": @TS@}
{"kill": "false", "modes": {}, "ts": @TS@}
{"kill": False, "modes": {}, "ts": @TS@}
{"kill": false, "modes": {"opd9": "heal"}, "ts": 0@TS@}
{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@.0}
{"kill": false, "modes": {"opd9": "heal"}, "ts": "@TS@"}
{"kill": false, "modes": {"opd9": "heal"}, "ts": -@TS@}
{"kill": false, "modes": {"opd9": "heal"}, "ts": 99999999999999999}
{"kill": false, "modes": {"opd9": "heal"}, "ts": 1 2}
{"kill": false, "modes": {"opd9": "heal", "opd9": "shadow"}, "ts": @TS@}
{"kill": false, "modes": {"OPD9": "heal"}, "ts": @TS@}
{"kill": false, "modes": {"": "heal"}, "ts": @TS@}
{"kill": false, "modes": {"opd9": "HEAL"}, "ts": @TS@}
{"kill": false, "modes": {"opd9": "heal "}, "ts": @TS@}
{"kill": false, "modes": {"opd9": "off"}, "ts": @TS@}
{ "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}
 {"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}
{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@} 
{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}{"kill": true}
{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}x
x{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}
{"kill":false,"modes":{"opd9":"heal"},"ts":@TS@}
{"modes": {"opd9": "heal"}, "kill": false, "ts": @TS@}
{"kill": false, "ts": @TS@, "modes": {"opd9": "heal"}}
{'kill': false, 'modes': {'opd9': 'heal'}, 'ts': @TS@}
LIST
  # escaped keys, built with a real backslash byte
  for p in \
    '{"kill": false, "modes": {}, "'"$bs"'u006bill": true, "ts": @TS@}' \
    '{"kill": false, "modes": {}, "k'"$bs"'u0069ll": true, "ts": @TS@}' \
    '{"kill": false, "modes": {"opd9": "heal"}, "x'"$bs"'"y": 1, "ts": @TS@}' \
    '{"kill": false, "modes": {"opd'"$bs"'u0039": "heal"}, "ts": @TS@}' \
    '{"kill": false, "modes": {"opd9": "he'"$bs"'u0061l"}, "ts": @TS@}'
  do
    p="${p//@TS@/$now}"; n=$((n + 1))
    ctl_engaged 1 "$p"; assert_rc $? 0 "escaped bypass shape $n"
    has_bs "$STATE_DIR/control.last" && ok || fail "escaped shape $n holds no backslash"
  done
  assert_eq "$([ "$n" -ge 58 ] && echo enough)" "enough" "bypass payload count ($n)"
  echo "BYPASS_COUNT=$n" >"$T/bypass_count.txt"
  assert_eq "$(current_mode)" "shadow" "shadow after the last bypass"
}

test_two_heal_keys_for_this_room_is_killed_and_bad_room_name_is_shadow() {
  use_ctl
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal", "opd9": "heal"}, "ts": @TS@}'; assert_rc $? 0 "room twice, both heal"
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "shadow", "opd9": "heal"}, "ts": @TS@}'; assert_rc $? 0 "room twice, shadow then heal"
  ctl_engaged 1 '{"kill": false, "modes": {"opd8": "heal", "opd9": "heal"}, "ts": @TS@}'; assert_rc $? 1 "another room is not a duplicate"
  assert_eq "$(current_mode)" "heal" "heal for the one room"
  GUARDIAN_ROOM='OPD9'
  ctl_engaged 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'; assert_rc $? 1 "clear"
  assert_eq "$(current_mode)" "shadow" "a room name outside [a-z0-9_-] is never heal"
}

test_no_scanner_is_left() {
  assert_eq "$(grep -c 'awk' "$KDIR/lib/killswitch.sh")" "0" "no awk in killswitch.sh"
  assert_eq "$(grep -rl 'control_top_keys' "$KDIR/lib" "$KDIR/bin" | wc -l | tr -d ' ')" "0" "control_top_keys is gone"
  assert_eq "$(grep -rn 'python' "$KDIR/lib" "$KDIR/bin" | grep -vc '^[^:]*:[0-9]*:#')" "0" "no python outside comments in kiosk code"
}

# ---- R8: payload cap 4096 (not the file), raw check independent of the caller's locale ----
# canon_len <ts> <target length>: canonical payload (python3 json.dumps, sort_keys) of exactly <target> bytes; opd9 is heal
canon_len() {
  python3 -I -c '
import json, sys
ts, target = int(sys.argv[1]), int(sys.argv[2])
modes = {"opd9": "heal"}
def dump(m): return json.dumps({"kill": False, "modes": m, "ts": ts}, sort_keys=True)
i = 0
while len(modes) < 63:
    i += 1
    name = ("r%03d" % i).ljust(64, "x")
    trial = dict(modes); trial[name] = "shadow"
    if len(dump(trial)) > target - 8: break
    modes = trial
for n in range(1, 65):
    name = ("z" + "y" * 80)[:n]
    trial = dict(modes); trial[name] = "shadow"
    if len(dump(trial)) == target: modes = trial; break
out = dump(modes)
assert len(out) == target, (len(out), target)
sys.stdout.write(out)
' "$@"
}

test_payload_of_exactly_4096_bytes_is_accepted_4097_is_killed() {
  use_ctl
  local p
  p="$(canon_len "$GUARDIAN_FAKE_NOW" 4096)"; assert_eq "${#p}" "4096" "built payload length"
  ctl_engaged 1 "$p"; assert_rc $? 1 "4096-byte canonical payload is accepted"
  assert_eq "$(current_mode)" "heal" "heal read from a 4096-byte payload"
  assert_eq "$([ "$(wc -c <"$STATE_DIR/control.last" | tr -d ' ')" -gt 4096 ] && echo over)" "over" "the file itself is over 4096 (payload cap, not file cap)"
  p="$(canon_len "$GUARDIAN_FAKE_NOW" 4095)"; ctl_engaged 1 "$p"; assert_rc $? 1 "4095 accepted"
  p="$(canon_len "$GUARDIAN_FAKE_NOW" 4097)"; assert_eq "${#p}" "4097" "built payload length"
  ctl_engaged 1 "$p"; assert_rc $? 0 "4097-byte payload killed"
  assert_eq "$(current_mode)" "shadow" "shadow"
  # file framing: a file over payload cap + 17 is killed whatever its content
  p="$(canon_len "$GUARDIAN_FAKE_NOW" 4096)"
  { printf '%s\n' "$((GUARDIAN_FAKE_NOW - 1))"; printf '%s\n' "$p"; printf 'x%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; } >"$STATE_DIR/control.last"
  raw_engaged; assert_rc $? 0 "4096 payload plus extra bytes beyond the frame"
}

test_raw_check_catches_a_high_byte_under_a_utf8_locale_with_lc_all_unset() {
  use_ctl
  unset LC_ALL; export LANG=en_US.UTF-8 LC_CTYPE=en_US.UTF-8
  write_raw 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\377' "$GUARDIAN_FAKE_NOW"
  has_byte "$STATE_DIR/control.last" ff && ok || fail "no 0xFF in file"
  raw_engaged; assert_rc $? 0 "0xFF killed"
  assert_eq "$CTRL_WHY" "rawbytes" "caught by the raw check itself"
  write_raw 1 '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\303\251' "$GUARDIAN_FAKE_NOW"
  raw_engaged; assert_rc $? 0 "a valid UTF-8 e-acute killed"
  assert_eq "$CTRL_WHY" "rawbytes" "caught by the raw check itself (UTF-8)"
}

# NUL on the wire: bash read would drop it before control_store; control_loop maps it to 0x01 so the file check kills the message
test_nul_inside_false_on_the_wire_is_killed_through_control_loop() {
  load_libs
  use_ctl
  export GUARDIAN_CONTROL_SUB_CMD='printf "{\"kill\": fa\000lse, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\n" "$GUARDIAN_FAKE_NOW"; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
  start_loops control_loop
  local i=0
  while [ "$i" -lt 40 ] && ! grep -q 'kill' "$STATE_DIR/control.last" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  has_byte "$STATE_DIR/control.last" 01 && ok || fail "control.last holds no 0x01 byte"
  has_byte "$STATE_DIR/control.last" 00 && fail "a NUL reached the file" || ok
  assert_has "$(sed -n '2p' "$STATE_DIR/control.last" | tr '\001' '#')" 'fa#lse' "the NUL became one 0x01 inside false"
  rm -f "$STATE_DIR/control_latch"; flag_fetch; killswitch_engaged; assert_rc $? 0 "control_parse kills it"
  assert_eq "$CTRL_WHY" "rawbytes" "by the raw-byte check"
  assert_eq "$(current_mode)" "shadow" "no heal"
}

test_backslashes_survive_control_loop() {
  load_libs
  export GUARDIAN_CONTROL_SUB_CMD='printf "%s\n" "{\"kill\": false, \"x\": \"a\\\\b\"}"; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
  start_loops control_loop
  local i=0
  while [ "$i" -lt 40 ] && ! grep -q 'kill' "$STATE_DIR/control.last" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  has_bs "$STATE_DIR/control.last" && ok || fail "the backslash did not survive read -r"
}

# a message from a stream that stays open must reach control.last before EOF (a buffering filter would hold it back)
test_message_from_a_still_open_stream_reaches_control_last_before_eof() {
  load_libs
  export GUARDIAN_CONTROL_SUB_CMD='printf "{\"kill\": false, \"modes\": {}, \"ts\": %s}\n" "$GUARDIAN_FAKE_NOW"; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
  start_loops control_loop
  local i=0
  while [ "$i" -lt 20 ] && ! grep -q '"kill": false' "$STATE_DIR/control.last" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  assert_eq "$(alive_of ctl)" "1" "the stream is still open (its sleep is running)"
  assert_has "$(sed -n '2p' "$STATE_DIR/control.last" 2>/dev/null)" '"kill": false' "line stored within 2 s while the stream is open"
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
}

test_kiosk_code_has_no_perl_python_osascript_or_jq() {
  assert_eq "$(grep -rnE '\b(perl|python3?|osascript|jq)\b' "$KDIR/bin" "$KDIR/lib" | grep -vcE '^[^:]*:[0-9]+:[[:space:]]*#')" "0" "no perl, python, osascript or jq outside comments"
}

# ---- R10 ----
test_guardian_version_is_bumped_and_identifies_the_tree() {
  load_libs
  [ "$GUARDIAN_VERSION" != "c1-0.1.0" ] && ok || fail "GUARDIAN_VERSION is still c1-0.1.0"
  assert_eq "$GUARDIAN_VERSION" "c1-0.4.3-r15c" "version string"
}

# a fake tr, wc, sed, ps, tail, head or cat first on PATH must not be used on the control path
test_pinned_tools_ignore_fakes_earlier_on_path() {
  use_ctl
  local t funcs
  funcs="$(guardian_funcs)"
  put_ctl 1 "$HEAL"
  for t in tr wc sed tail head cat ps date mv mkdir; do
    printf '#!/bin/bash\necho %s >>"%s/fake_used"\necho 99999\nexit 1\n' "$t" "$T" >"$T/bin/$t"; chmod +x "$T/bin/$t"
  done
  assert_eq "$(command -v tr)" "$T/bin/tr" "the fake tr is first on PATH"
  flag_fetch; killswitch_engaged; assert_rc $? 1 "fresh heal payload is clear with fakes on PATH"
  assert_eq "$(current_mode)" "heal" "mode read with fakes on PATH"
  [ ! -e "$T/fake_used" ] && ok || fail "a fake tool ran: $(cat "$T/fake_used")"
  assert_eq "$G_TR" "/usr/bin/tr" "tr pinned"
  assert_eq "$G_WC" "/usr/bin/wc" "wc pinned"
  assert_eq "$G_SED" "/usr/bin/sed" "sed pinned"
  assert_eq "$G_PS" "/bin/ps" "ps pinned"
  assert_eq "$G_DATE" "/bin/date" "date pinned"
  assert_eq "$G_MV" "/bin/mv" "mv pinned"
  assert_eq "$G_MKDIR" "/bin/mkdir" "mkdir pinned"
  assert_eq "$(flag_poll; echo ran)" "ran" "flag_poll with fakes on PATH"
  [ ! -e "$T/fake_used" ] && ok || fail "a fake tool ran in flag_poll: $(cat "$T/fake_used")"
  # the NUL filter and the loop supervision, from the real guardian.sh
  ( eval "$funcs"; printf 'a\000b' | nul_to_soh | /usr/bin/od -An -tx1 | /usr/bin/tr -d ' \n' ) >"$T/nul.out" 2>&1
  assert_eq "$(cat "$T/nul.out")" "610162" "nul_to_soh did not use the fake tr"
  [ ! -e "$T/fake_used" ] && ok || fail "a fake tool ran in nul_to_soh: $(cat "$T/fake_used")"
}

test_control_path_code_has_no_bare_tr_wc_sed_ps() {
  local n
  n="$(sed -n '/^control_parse()/,/^control_audit_change/p;/^flag_fetch()/,$p' "$KDIR/lib/killswitch.sh" | grep -v '^[[:space:]]*#' | grep -v 'run_capped\|grep -' | grep -cE '(^|[|;&(`[:space:]])(tr|wc|sed|ps|tail|head|cat|mv|mkdir|date)[[:space:]]')"
  assert_eq "$n" "0" "no bare tool name in control_parse / flag_fetch / killswitch_engaged / current_mode / flag_poll"
  assert_eq "$(sed -n "/^now_epoch()/,/^}/p;/^ist_hhmm()/,/^}/p" "$KDIR/lib/common.sh" | grep -v "^[[:space:]]*#" | grep -cE "(^|[ |;(])date ")" "0" "no bare date in now_epoch / ist_hhmm"
  n="$(sed -n '/^loop_parent_ok()/,/^loop_nap/p;/^nul_to_soh()/,/^}/p' "$KDIR/bin/guardian.sh" | grep -v '^[[:space:]]*#' | grep -v 'audit ' | grep -cE '(^|[|;&(`[:space:]=])(tr|wc|sed|ps|/bin/ps)[[:space:]]')"
  assert_eq "$n" "0" "no bare tool name in the loop helpers"
}

# overlong_run <sub cmd body>: run control_loop on an open stream, wait for control.last to change from the good HEAL payload
overlong_run() {
  put_ctl 0 "$HEAL"; flag_fetch; killswitch_engaged; assert_rc $? 1 "good payload before the long line"
  export GUARDIAN_CONTROL_SUB_CMD="$1"'; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
  start_loops control_loop
  local i=0
  while [ "$i" -lt 80 ] && ! grep -q 'overlong' "$STATE_DIR/control.last" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
}
overlong_check() { # <label>
  flag_fetch; killswitch_engaged; assert_rc $? 0 "$1: killed"
  assert_eq "$(current_mode)" "shadow" "$1: shadow"
  assert_eq "$(sed -n '2p' "$STATE_DIR/control.last")" "overlong" "$1: only the marker was stored"
  [ "$(wc -c <"$STATE_DIR/control.last" | tr -d ' ')" -lt 100 ] && ok || fail "$1: control.last holds the long line"
}

test_5kb_line_is_killed_and_not_stored() {
  use_ctl
  overlong_run '/usr/bin/head -c 5000 /dev/zero | /usr/bin/tr "\000" a; printf "\n"'
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  overlong_check "5 KB"
}

test_70kb_line_is_killed_and_not_stored() {
  use_ctl
  overlong_run '/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr "\000" a; printf "\n"'
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  overlong_check "70 KB"
}

test_remainder_of_an_overlong_line_is_not_stored_as_a_line() {
  use_ctl
  # 4300 filler bytes, then a canonical payload on the SAME line: the tail must not become a valid line
  overlong_run 'printf "%s" "$(/usr/bin/head -c 4300 /dev/zero | /usr/bin/tr "\000" a)"; printf "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\n" "$GUARDIAN_FAKE_NOW"'
  sleep 1
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  overlong_check "tail of a long line"
}

test_overlong_line_then_canonical_line_the_canonical_line_lands() {
  use_ctl
  overlong_run '/usr/bin/head -c 4300 /dev/zero | /usr/bin/tr "\000" a; printf "\n"; printf "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\n" "$GUARDIAN_FAKE_NOW"'
  local i=0
  while [ "$i" -lt 40 ] && ! grep -q '"kill": false' "$STATE_DIR/control.last" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  assert_has "$(sed -n '2p' "$STATE_DIR/control.last")" '"opd9": "heal"' "the canonical line after the long one landed"
  flag_fetch; killswitch_engaged; assert_rc $? 1 "and it is accepted"
  assert_eq "$(current_mode)" "heal" "heal from the line after the long one"
}

test_4200_byte_line_is_a_line_and_4201_is_not() {
  use_ctl
  # exactly CONTROL_LINE_MAX bytes is stored as a line (and then fails the form check); one more is the marker
  export GUARDIAN_CONTROL_SUB_CMD='/usr/bin/head -c 4200 /dev/zero | /usr/bin/tr "\000" a; printf "\n"; sleep 30 & echo $! >>"$T/ctl.pid"; wait'
  start_loops control_loop
  local i=0 sz=0
  while [ "$i" -lt 40 ] && [ "$sz" -lt 4200 ]; do sleep 0.1; i=$((i + 1)); sz="$(wc -c <"$STATE_DIR/control.last" 2>/dev/null | tr -d ' ')"; sz="${sz:-0}"; done
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  [ "$sz" -ge 4200 ] && ok || fail "a 4200-byte line was not stored"
  flag_fetch; killswitch_engaged; assert_rc $? 0 "killed by the form check"
}

# an endless line with no LF: memory of the reader stays bounded, nothing valid is stored, and the state is killed
test_endless_line_without_lf_keeps_memory_bounded_and_stores_nothing() {
  use_ctl
  put_ctl 0 "$HEAL"; flag_fetch
  ( eval "$(guardian_funcs)"; control_pump < <(/usr/bin/head -c 3000000 /dev/zero | /usr/bin/tr '\000' a; sleep 3) ) >/dev/null 2>&1 &
  local pp=$! r max=0 base=0 i=0
  echo "$pp" >>"$T/pump.pid"
  while kill -0 "$pp" 2>/dev/null && [ "$i" -lt 200 ]; do
    r="$(/bin/ps -o rss= -p "$pp" 2>/dev/null | tr -d ' ')"
    if [ -n "$r" ]; then [ "$base" -eq 0 ] && base="$r"; [ "$r" -gt "$max" ] && max="$r"; fi
    sleep 0.1; i=$((i + 1))
  done
  kill "$pp" 2>/dev/null; wait "$pp" 2>/dev/null
  [ "$((max - base))" -lt 1500 ] && ok || fail "reader RSS grew by $((max - base)) KB over a 3 MB line"
  assert_eq "$(sed -n '2p' "$STATE_DIR/control.last")" "overlong" "nothing but the marker stored"
  flag_fetch; killswitch_engaged; assert_rc $? 0 "killed"
}

# ---- R10: exact canonical modes (payloads from the real json.dumps, tests only) ----
ctl_json() { # <ts> <kill py literal> <modes as py dict literal> [sort|nosort]; isolated python, literal parse only (no eval)
  python3 -I -c 'import ast,json,sys; print(json.dumps({"kill": sys.argv[2]=="True", "modes": ast.literal_eval(sys.argv[3]), "ts": int(sys.argv[1])}, sort_keys=(sys.argv[4]=="sort")))' "$1" "$2" "$3" "${4:-sort}"
}

test_json_dumps_sorted_modes_are_accepted() {
  use_ctl
  local p
  p="$(ctl_json "$GUARDIAN_FAKE_NOW" False '{"z-room":"shadow","opd9":"heal","opd10":"shadow","a":"shadow","a-b":"shadow","a1":"shadow","a_b":"heal","opd2":"heal"}')"
  assert_has "$p" '"a": "shadow", "a-b"' "python sorted a before a-b"
  ctl_engaged 1 "$p"; assert_rc $? 1 "sorted modes accepted"
  assert_eq "$(current_mode)" "heal" "this room's key read from a real json.dumps payload"
  ctl_engaged 1 "$(ctl_json "$GUARDIAN_FAKE_NOW" False '{}')"; assert_rc $? 1 "empty modes accepted"
  ctl_engaged 1 "$(ctl_json "$GUARDIAN_FAKE_NOW" False '{"opd9":"shadow"}')"; assert_rc $? 1 "one room accepted"
}

test_unsorted_or_duplicate_modes_keys_are_killed() {
  use_ctl
  local ts="$GUARDIAN_FAKE_NOW" p
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd9\": \"heal\", \"opd2\": \"shadow\"}, \"ts\": $ts}"; assert_rc $? 0 "unsorted (this room first)"
  assert_eq "$CTRL_WHY" "unparseable" "by the modes check"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd3\": \"heal\", \"opd2\": \"shadow\", \"opd9\": \"heal\"}, \"ts\": $ts}"; assert_rc $? 0 "unsorted other rooms"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd2\": \"heal\", \"opd2\": \"shadow\", \"opd9\": \"heal\"}, \"ts\": $ts}"; assert_rc $? 0 "duplicate other room, adjacent"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd2\": \"heal\", \"opd9\": \"heal\", \"opd2\": \"heal\"}, \"ts\": $ts}"; assert_rc $? 0 "duplicate other room, apart"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"opd9\": \"heal\", \"opd9\": \"heal\"}, \"ts\": $ts}"; assert_rc $? 0 "duplicate this room"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {\"a-b\": \"shadow\", \"a\": \"shadow\", \"opd9\": \"heal\"}, \"ts\": $ts}"; assert_rc $? 0 "prefix order wrong"
  p="$(ctl_json "$ts" False '{"opd9":"heal","opd2":"shadow"}' nosort)"
  assert_has "$p" '"opd9": "heal", "opd2"' "python insertion order, not sorted"
  ctl_engaged 1 "$p"; assert_rc $? 0 "json.dumps without sort_keys, unsorted"
  assert_eq "$(current_mode)" "shadow" "no heal from an unsorted payload"
}

test_flag_max_age_does_not_abort_a_long_heal_action_under_the_control_subscription() {
  use_ctl
  put_ctl 0 "$HEAL"; flag_fetch
  # a 40 s action: the cache is older than FLAG_MAX_AGE_S (30) but the live file is fresh again
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 40)); put_ctl 0 "$HEAL"
  killswitch_engaged; assert_rc $? 1 "fresh live file, old cache: not engaged (no spurious aborted_killswitch)"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 100)); killswitch_engaged; assert_rc $? 0 "live file stale: still engaged"
  # the flag-command path keeps its age limit
  GUARDIAN_CONTROL_SUB_CMD=""; go_heal; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 40)); killswitch_engaged; assert_rc $? 0 "flag cmd path: a 40 s old cache is engaged"
}

# ---- R11: the clock is pinned, and a fake clock exists only in test mode ----
real_now() { /bin/date +%s; }

test_planted_date_on_path_is_not_used_and_the_90s_rule_still_fires() {
  use_ctl
  unset GUARDIAN_FAKE_NOW GUARDIAN_TESTMODE
  local rn; rn="$(real_now)"
  # a fake date that always reports 100 s before the real time: if it were used, a 100 s old message would look fresh
  printf '#!/bin/bash\necho %s\n' "$((rn - 100))" >"$T/bin/date"; chmod +x "$T/bin/date"
  assert_eq "$(PATH="$T/bin:$PATH" command -v date)" "$T/bin/date" "the planted date is first on PATH"
  local n; n="$(now_epoch)"
  [ "$n" -ge "$rn" ] && [ "$n" -le "$((rn + 3))" ] && ok || fail "now_epoch used the planted date: $n vs real $rn"
  put_epoch() { { printf '%s\n' "$1"; printf '%s\n' "${HEAL//@TS@/$1}"; } >"$STATE_DIR/control.last"; }
  put_epoch "$((rn - 100))"; flag_fetch; killswitch_engaged; assert_rc $? 0 "100 s old message is stale, planted date ignored"
  assert_eq "$CTRL_WHY" "stale" "reason is stale"
  put_epoch "$rn"; rm -f "$STATE_DIR/control_latch"; flag_fetch; killswitch_engaged; assert_rc $? 1 "a fresh message is still clear"
}

test_fake_now_is_ignored_outside_test_mode() {
  use_ctl
  unset GUARDIAN_TESTMODE
  local rn; rn="$(real_now)"
  GUARDIAN_FAKE_NOW=5
  local n; n="$(now_epoch)"
  [ "$n" -ge "$rn" ] && [ "$n" -le "$((rn + 3))" ] && ok || fail "env GUARDIAN_FAKE_NOW honoured without test mode: $n"
  GUARDIAN_TESTMODE=1; assert_eq "$(now_epoch)" "5" "honoured with GUARDIAN_TESTMODE=1"
  GUARDIAN_TESTMODE=0; n="$(now_epoch)"
  [ "$n" -ge "$rn" ] && [ "$n" -le "$((rn + 3))" ] && ok || fail "TESTMODE=0 honoured the fake clock: $n"
  # a frozen clock must not disable the kill: message 200 s old by the real clock
  GUARDIAN_TESTMODE=""; unset GUARDIAN_TESTMODE
  { printf '%s\n' "$((rn - 200))"; printf '%s\n' "${HEAL//@TS@/$((rn - 200))}"; } >"$STATE_DIR/control.last"
  GUARDIAN_FAKE_NOW="$((rn - 200))"
  flag_fetch; killswitch_engaged; assert_rc $? 0 "frozen fake clock in env does not keep a stale message alive"
}

test_fake_now_in_guardian_conf_is_ignored_without_test_mode() {
  load_libs; mk_tcc 2
  local conf="$T/guardian.conf" ts
  printf 'GUARDIAN_FAKE_NOW=5\nGUARDIAN_TESTMODE=1\n' >"$conf"
  unset GUARDIAN_TESTMODE GUARDIAN_FAKE_NOW
  GUARDIAN_CONF="$conf" bash "$KDIR/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 c1"
  ts="$(grep -o '"ts":[0-9]*' "$T/pub.log" | head -n1 | cut -d: -f2)"
  [ -n "$ts" ] && [ "$ts" != "5" ] && ok || fail "probe ts from guardian.conf fake clock: [$ts]"
  printf 'GUARDIAN_FAKE_NOW=5\n' >"$conf"; : >"$T/pub.log"
  GUARDIAN_CONF="$conf" bash "$KDIR/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 c2"
  ts="$(grep -o '"ts":[0-9]*' "$T/pub.log" | head -n1 | cut -d: -f2)"
  [ -n "$ts" ] && [ "$ts" != "5" ] && ok || fail "probe ts from conf FAKE_NOW only: [$ts]"
  # and with the environment's own test mode the fake clock is used
  : >"$T/pub.log"
  GUARDIAN_TESTMODE=1 GUARDIAN_CONF=/dev/null GUARDIAN_FAKE_NOW=5 bash "$KDIR/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 c3"
  ts="$(grep -o '"ts":[0-9]*' "$T/pub.log" | head -n1 | cut -d: -f2)"
  assert_eq "$ts" "5" "test mode from the environment honours the fake clock"
}

# ---- R11: the modes loop is cheap at 64 rooms ----
test_modes_walk_64_rooms_single_pass_is_correct_and_fast() {
  use_ctl
  local m="" i
  for i in $(seq 100 163); do m="$m\"r$i\": \"shadow\", "; done
  m="${m%, }"
  GUARDIAN_ROOM="r107"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {$m}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 1 "64 sorted rooms accepted"
  m="${m/\"r150\": \"shadow\", \"r151\"/\"r151\": \"shadow\", \"r150\"}"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {$m}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 0 "one adjacent swap among 64 killed"
  m="${m/\"r151\": \"shadow\", \"r150\"/\"r150\": \"shadow\", \"r150\"}"
  ctl_engaged 1 "{\"kill\": false, \"modes\": {$m}, \"ts\": $GUARDIAN_FAKE_NOW}"; assert_rc $? 0 "a duplicate among 64 killed"
}

test_no_sandbox_leaks_under_the_runner_parent() {
  case "$T" in "$SBROOT"/sb.*) ok ;; *) fail "sandbox $T is not under SBROOT [$SBROOT]" ;; esac
  assert_eq "$(find "$SBROOT" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" "1" "only this test's sandbox exists"
}
