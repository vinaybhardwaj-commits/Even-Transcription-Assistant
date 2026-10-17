#!/bin/bash
# shellcheck disable=SC2059
# Sentinel S3 (G1 form 3): the control payload may begin with consult_live.
# Form 3 (json.dumps sort_keys): {"consult_live": {...}, "consult_open": {...}, "kill": true|false, "modes": {...}, "ts": <epoch>}
# Uses t_control.sh's put_ctl / use_ctl / ctl_engaged / write_raw / raw_engaged / has_byte (same runner, sourced earlier in glob order).
# s3_ctl <age> <payload>: control.last as the subscriber would write it, then a fresh fetch+parse; prints the observable state.
s3_ctl() {
  rm -f "$STATE_DIR/control_latch"
  put_ctl "$1" "$2"
  flag_fetch
  printf '%s|%s|%s|%s|%s|%s' "$?" "$CTRL_FLEET" "$CTRL_MODE" "$CTRL_WHY" "$CTRL_HOLD" "$CTRL_LIVE"
}

test_form3_valid_true_false_absent() {
  use_ctl
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|clear|live" "this room true = live, hold clear, heal"
  assert_eq "$(current_mode)" "heal" "heal from the form-3 line"
  killswitch_engaged; assert_rc $? 1 "kill=false: not engaged"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": false}, \"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|clear|not_live" "this room false = not_live"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd2\": true, \"opd8\": true}, \"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|clear|unknown" "other rooms only: absent = unknown (mutant a: not not_live)"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {}, \"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|clear|unknown" "empty map: absent = unknown"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|set|live" "no consult_open member: live still read, hold stays set"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": false}, \"kill\": true, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "1|unreachable|shadow|kill|set|unknown" "kill=true wins, live never read"
}

# s3_mal <live dict text>: form-3 line with that consult_live text, kill=false, heal mode, well-formed consult_open
s3_mal() {
  s3_ctl 1 "{\"consult_live\": $1, \"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}"
}

test_form3_malformed_live_leaves_kill_and_modes_unchanged() {
  use_ctl
  local i=0 obs
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    i=$((i + 1))
    obs="$(s3_mal "$d")"
    assert_eq "$obs" "0|on|heal|ok|clear|unknown" "malformed live $i: kill/modes/consult_open unchanged, live unknown"
  done <<'LIST'
{"opd9": null}
{"opd9": 1}
{"opd9": "true"}
{"opd9": [false]}
{"opd9": {"x": false}}
{"OPD9": true}
{"opd 9": true}
{"": true}
{"opd9": true, "opd9": false}
{"z": true, "opd9": false}
{"opd9": true "x": false}
{"opd9": true,}
{"opd9": true
{"opd9": true}}
true
LIST
  assert_eq "$i" "15" "malformed-variant count"
  killswitch_engaged; assert_rc $? 1 "a malformed live never engages (mutant b: a malformed live triggering kill)"
  assert_eq "$(current_mode)" "heal" "modes still read with a malformed live"
}

test_form3_malformed_live_with_kill_true_stays_engaged() {
  use_ctl
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": null}, \"kill\": true, \"modes\": {}, \"ts\": $GUARDIAN_FAKE_NOW}")" "1|unreachable|shadow|kill|set|unknown" "a real kill is not masked by a malformed live"
  killswitch_engaged; assert_rc $? 0 "engaged"
}

# the old forms, byte for byte: same parse result as before form 3 existed, and live is unknown in every one of them
test_old_forms_are_byte_identical_and_live_unknown() {
  use_ctl
  assert_eq "$(s3_ctl 1 "{\"kill\": false, \"modes\": {\"opd2\": \"shadow\", \"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|set|unknown" "old form: heal room, hold set"
  assert_eq "$(s3_ctl 1 "{\"kill\": false, \"modes\": {\"opd9\": \"shadow\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|shadow|ok|set|unknown" "old form: shadow room"
  assert_eq "$(s3_ctl 1 "{\"kill\": false, \"modes\": {\"opd2\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|shadow|ok|set|unknown" "old form: other room's heal does not count"
  assert_eq "$(s3_ctl 1 "{\"kill\": true, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "1|unreachable|shadow|kill|set|unknown" "old form: kill"
  assert_eq "$(s3_ctl 1 "{\"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|clear|unknown" "form 2: hold clear"
  assert_eq "$(s3_ctl 1 "{\"consult_open\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|set|unknown" "form 2: hold set on true"
  assert_eq "$(s3_ctl 1 "{\"consult_open\": {\"opd9\": \"x\"}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|set|unknown" "form 2: malformed consult_open unchanged"
  assert_eq "$(s3_ctl 1 "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}}")" "1|unreachable|shadow|unparseable|set|unknown" "old form: no ts still killed"
  assert_eq "$(s3_ctl 1 "{\"kill\":false,\"modes\":{\"opd9\":\"heal\"},\"ts\":$GUARDIAN_FAKE_NOW}")" "1|unreachable|shadow|unparseable|set|unknown" "old form: compact spacing still killed"
  assert_eq "$(s3_ctl 1 "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $((GUARDIAN_FAKE_NOW - 91))}")" "1|unreachable|shadow|stale|set|unknown" "old form: stale ts still killed"
}

test_form3_stale_and_skew_still_apply() {
  use_ctl
  assert_eq "$(s3_ctl 91 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "1|unreachable|shadow|stale|set|unknown" "receive age 91: stale"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $((GUARDIAN_FAKE_NOW - 91))}")" "1|unreachable|shadow|stale|set|unknown" "ts 91 s old: stale"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $((GUARDIAN_FAKE_NOW + 31))}")" "1|unreachable|shadow|skew|set|unknown" "ts 31 s ahead: skew"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $((GUARDIAN_FAKE_NOW + 30))}")" "0|on|heal|ok|set|live" "ts 30 s ahead: tolerated"
}

test_form3_room_named_keys_do_not_move_the_boundaries() {
  use_ctl
  # a room named consult_open and a room named kill inside the live map
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"consult_open\": true, \"kill\": true}, \"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|clear|unknown" "live keys named consult_open/kill: boundaries hold, our room absent"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"kill\": true, \"opd9\": true}, \"consult_open\": {\"opd9\": false}, \"kill\": false, \"modes\": {\"kill\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|shadow|ok|clear|live" "modes key named kill: modes parsed, live read"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"consult_open\": {\"consult_open\": false, \"opd9\": false}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|clear|live" "consult_open key named consult_open: hold still clear"
}

test_form3_oversized_and_injection_are_rejected() {
  use_ctl
  local pad obs
  pad="$(head -c 200000 /dev/zero | tr '\0' x)"
  obs="$(s3_ctl 1 "{\"consult_live\": {\"opd9\": \"$pad\"}, \"kill\": false, \"modes\": {}, \"ts\": $GUARDIAN_FAKE_NOW}")"
  assert_eq "$obs" "1|unreachable|shadow|unparseable|set|unknown" "200 KB live value: killed by the cap"
  killswitch_engaged; assert_rc $? 0 "engaged"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {}, \"ts\": $GUARDIAN_FAKE_NOW} x")" "1|unreachable|shadow|unparseable|set|unknown" "junk after the object"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW, \"kill\": true}")" "1|unreachable|shadow|unparseable|set|unknown" "duplicate kill after form 3"
  # a 65-room live map: the map is unknown, but the line still parses (kill unchanged)
  local big="" i
  for i in $(seq 1 65); do [ -n "$big" ] && big="$big, "; big="$big\"room-$i\": false"; done
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {$big}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|heal|ok|set|unknown" "65 rooms: map over the 64 cap = unknown, kill unchanged"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {}, \"ts\": $GUARDIAN_FAKE_NOW}")" "0|on|shadow|ok|set|unknown" "duplicate consult_live member: the map is unknown, kill unchanged (as a duplicate consult_open is not a kill in form 2)"
}

test_form3_special_bytes_are_killed_by_the_raw_check() {
  use_ctl
  local ts="$GUARDIAN_FAKE_NOW"
  write_raw 1 '{"consult_live": {"opd9": "he\000al"}, "kill": false, "modes": {}, "ts": %s}' "$ts"
  has_byte "$STATE_DIR/control.last" 00 && ok || fail "no NUL in file"
  raw_engaged; assert_rc $? 0 "NUL inside the live map killed"
  assert_eq "$CTRL_WHY" "rawbytes" "by the raw-byte check, before the form-3 peel"
  assert_eq "$(current_mode)" "shadow" "no heal"
}

test_form3_payload_cap_4096() {
  use_ctl
  # 64-room live + 64-room modes (short names) fits the byte cap
  local live="" modes="" i p
  for i in $(seq 1 63); do live="${live}${live:+, }\"$(printf 'lr%03d' "$i")\": false"; done
  live="${live}${live:+, }\"opd9\": true"
  for i in $(seq 1 63); do modes="${modes}${modes:+, }\"$(printf 'mr%03d' "$i")\": \"shadow\""; done
  modes="${modes}${modes:+, }\"opd9\": \"heal\""
  p="{\"consult_live\": {$live}, \"kill\": false, \"modes\": {$modes}, \"ts\": $GUARDIAN_FAKE_NOW}"
  [ "$(wc -c <<<"$p")" -le 4096 ] && ok || fail "the 64+64 line is not under the cap: ${#p}"
  assert_eq "$(s3_ctl 1 "$p")" "0|on|heal|ok|set|live" "64+64 rooms: accepted, live read"
  # 65 live rooms (short names): the map is over its 64 cap = unknown, the line still parses
  live="${live}${live:+, }\"zz9\": false"
  p="{\"consult_live\": {$live}, \"kill\": false, \"modes\": {$modes}, \"ts\": $GUARDIAN_FAKE_NOW}"
  assert_eq "$(s3_ctl 1 "$p")" "0|on|heal|ok|set|unknown" "65 live rooms: map unknown, kill unchanged"
  # long room names push the line over the 4096 byte cap: killed before the form check
  local biglive="" bigmodes="" n
  for i in $(seq 1 60); do n="$(printf 'lr%062d' "$i")"; biglive="${biglive}${biglive:+, }\"$n\": false"; done
  for i in $(seq 1 60); do n="$(printf 'mr%062d' "$i")"; bigmodes="${bigmodes}${bigmodes:+, }\"$n\": \"shadow\""; done
  p="{\"consult_live\": {$biglive}, \"kill\": false, \"modes\": {$bigmodes}, \"ts\": $GUARDIAN_FAKE_NOW}"
  [ "$(wc -c <<<"$p")" -gt 4096 ] && ok || fail "the long-name line is not over the cap: ${#p}"
  assert_eq "$(s3_ctl 1 "$p")" "1|unreachable|shadow|unparseable|set|unknown" "over the 4096 byte cap: killed"
}

# consult_live_state: the exposed function (S4 will consume it)
test_consult_live_state_function() {
  use_ctl
  assert_eq "$(consult_live_state)" "unknown" "no control.last yet: unknown"
  put_ctl 1 "$OFF"; flag_fetch
  assert_eq "$(consult_live_state)" "unknown" "old form: unknown"
  put_ctl 1 '{"consult_open": {"opd9": false}, "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
  assert_eq "$(consult_live_state)" "unknown" "form 2: unknown"
  put_ctl 1 '{"consult_live": {"opd9": true}, "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
  assert_eq "$(consult_live_state)" "live" "form 3 true: live"
  put_ctl 1 '{"consult_live": {"opd9": false}, "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
  assert_eq "$(consult_live_state)" "not_live" "form 3 false: not_live"
  put_ctl 1 '{"consult_live": {"opd2": true}, "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
  assert_eq "$(consult_live_state)" "unknown" "absent room: unknown"
  put_ctl 1 '{"consult_live": {"opd9": true}, "kill": true, "modes": {}, "ts": @TS@}'
  assert_eq "$(consult_live_state)" "unknown" "kill: unknown"
  put_ctl 1 '{"consult_live": {"opd9": true}, "kill": false, "modes": {}, "ts": @TS@}'
  assert_eq "$(consult_live_state)" "live" "live again"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 91))
  assert_eq "$(consult_live_state)" "unknown" "stale control: unknown, never live"
  GUARDIAN_ROOM='OPD9'
  put_ctl 0 '{"consult_live": {"OPD9": true}, "kill": false, "modes": {}, "ts": @TS@}'
  assert_eq "$(consult_live_state)" "unknown" "an invalid room name is never live"
  # without the control command it is unknown, whatever the file says
  unset GUARDIAN_CONTROL_SUB_CMD; GUARDIAN_CONTROL_SUB_CMD=""
  assert_eq "$(consult_live_state)" "unknown" "no control command: unknown"
}

test_form3_line_rejected_before_is_still_rejected() {
  use_ctl
  local ts="$GUARDIAN_FAKE_NOW"
  # form 3 never widens the old rejections: these start with the consult_live prefix but are not form 3
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $ts}")" "1|unreachable|shadow|unparseable|set|unknown" "no kill member"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"ts\": $ts}")" "1|unreachable|shadow|unparseable|set|unknown" "no modes member"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": true, \"kill\": false, \"modes\": {}, \"ts\": $ts}")" "0|on|shadow|ok|set|unknown" "live as a scalar: unknown, kill unchanged"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true \"kill\": false, \"modes\": {}, \"ts\": $ts}")" "0|on|shadow|ok|set|unknown" "missing comma between the map and kill: unknown, kill unchanged"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\", \"opd2\": \"shadow\"}, \"ts\": $ts}")" "1|unreachable|shadow|unparseable|set|unknown" "unsorted modes still killed"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": $ts, \"ts\": $ts}")" "1|unreachable|shadow|unparseable|set|unknown" "duplicate ts still killed"
  assert_eq "$(s3_ctl 1 "{\"consult_live\": {\"opd9\": true}, \"kill\": false, \"modes\": {\"opd9\": \"heal\", \"opd9\": \"shadow\"}, \"ts\": $ts}")" "1|unreachable|shadow|unparseable|set|unknown" "duplicate modes key still killed"
}
