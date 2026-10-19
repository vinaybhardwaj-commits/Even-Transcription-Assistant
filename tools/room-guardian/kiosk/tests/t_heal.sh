#!/bin/bash
# Heal ladder (spec 2.4) and G1-G9 behaviour.
prep_denied() { # recorder says denied, row denied, idle capture, Mini says heal
  load_libs; mk_tcc 0; write_status mic_state=denied capture_open=false state=mic_denied
  touch "$T/boot_ok"; go_heal; collect_all
}

test_shadow_default_would_do_changes_nothing() {
  load_libs; mk_tcc 0; write_status mic_state=denied capture_open=false; go_shadow; collect_all
  heal_tcc
  assert_eq "$(tcc_val)" "0" "row untouched in shadow"
  assert_not "$(cat "$CALLS")" "tcc-heal\|coreaudiod-kill\|pmset-baseline\|tcc-prune" "no mutating root verb in shadow"
  assert_not "$(cat "$CALLS")" "launchctl boot" "no restart in shadow"
  assert_has "$(events)" '"result":"WOULD-DO"' "WOULD-DO published"
  assert_has "$(events)" '"shadow":true' "shadow flag"
}

test_default_with_no_control_is_off() {
  load_libs; mk_tcc 0; write_status mic_state=denied capture_open=false; collect_all
  killswitch_engaged; assert_rc $? 0 "no flag fetched means engaged"
  heal_tcc
  assert_eq "$(tcc_val)" "0" "row untouched"
  assert_eq "$(current_mode)" "shadow" "mode shadow"
}

test_a_tcc_heal_full_sequence() {
  prep_denied; sqlite3 "$T/TCC.db" "PRAGMA journal_mode=DELETE;" >/dev/null
  local before_other; before_other="$(other_val)"
  heal_tcc; assert_rc $? 0 "heal ok"
  assert_eq "$(tcc_val)" "2" "recorder row authorized"
  assert_eq "$(other_val)" "$before_other" "other app's row untouched"
  assert_eq "$(ls "$T"/TCC.db.bak-guardian-* | wc -l | tr -d ' ')" "1" "backup made"
  local t k b s
  t="$(lineno "$CALLS" 'killall -u')"; b="$(lineno "$CALLS" 'launchctl bootout')"; s="$(lineno "$CALLS" 'launchctl bootstrap')"
  [ "$t" -gt 0 ] && [ "$b" -gt "$t" ] && [ "$s" -gt "$b" ] && ok || fail "order tccd($t) < bootout($b) < bootstrap($s)"
  assert_has "$(cat "$CALLS")" "killall -u $(id -un) tccd" "tccd killed for the room user only"
  assert_not "$(cat "$CALLS")" kickstart "G1 no kickstart"
  assert_has "$(events)" '"result":"ok"' "heal event"
  assert_has "$(events)" '"action":"alert"' "alert after heal"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "line from log" "log lines copied to audit"
}

test_a_never_inserts_when_row_missing() {
  prep_denied; sqlite3 "$T/TCC.db" "DELETE FROM access WHERE client='com.evenscribe.room-recorder'"
  heal_tcc
  assert_eq "$(sqlite3 "$T/TCC.db" "SELECT count(*) FROM access")" "1" "no row inserted"
  assert_has "$(events)" "tcc_heal_failed:no_row" "escalated"
  assert_not "$(cat "$CALLS")" "launchctl boot" "no restart on failure"
}

test_a_changes_not_one_restores() {
  prep_denied
  sqlite3 "$T/TCC.db" "CREATE TRIGGER nop BEFORE UPDATE ON access BEGIN SELECT RAISE(IGNORE); END;"
  heal_tcc
  assert_eq "$(tcc_val)" "0" "unchanged after ignored update"
  assert_has "$(events)" "changes_0_restored" "restore path reported"
  assert_not "$(cat "$CALLS")" "launchctl boot" "no restart"
}

test_a_schema_drift_does_nothing() {
  prep_denied
  sqlite3 "$T/TCC.db" "ALTER TABLE access RENAME COLUMN auth_value TO auth_val;"
  heal_tcc
  assert_has "$(events)" "tcc_heal_failed:schema_drift" "schema guard"
  assert_eq "$(ls "$T"/TCC.db.bak-guardian-* 2>/dev/null | wc -l | tr -d ' ')" "0" "no backup, no write"
}

test_a_capture_open_logs_only() {
  load_libs; mk_tcc 0; write_status mic_state=denied capture_open=true; touch "$T/boot_ok"; go_heal; collect_all
  heal_tcc
  assert_eq "$(tcc_val)" "0" "row untouched while capture open"
  assert_not "$(cat "$CALLS")" "launchctl boot" "G3 no restart"
  assert_not "$(cat "$CALLS")" "tcc-heal\|tcc-prune" "no mutating root verb"
  assert_has "$(events)" "capture_open_no_restart" "log only"
}


test_a_restart_is_refused_with_tapewriter_running() {
  prep_denied; echo 5151 >"$T/tapewriters"
  heal_tcc
  assert_eq "$(tcc_val)" "0" "G3: a live tapewriter blocks the whole fix"
  assert_not "$(cat "$CALLS")" "launchctl boot" "no restart"
}

test_b_coreaudiod_only_when_no_capture() {
  load_libs; mk_tcc 2; : >"$T/engine.txt"; write_status capture_open=false; go_heal; collect_all
  ( sleep 0.2; echo 10000 >"$T/ca_pid" ) &
  CONFIRM_TIMEOUT_S=3 heal_coreaudiod; wait
  assert_has "$(cat "$CALLS")" "SUDO $GUARDIAN_ROOT_HELPER coreaudiod-kill" "via the sudo path"
  assert_has "$(events)" "coreaudiod_wedged" "event"
  : >"$CALLS"; : >"$T/pub.log"; write_status capture_open=true; collect_all
  heal_coreaudiod
  assert_not "$(cat "$CALLS")" "coreaudiod-kill" "capture open: never killed"
  assert_has "$(events)" '"action":"escalate"' "escalated instead"
}

test_c_recorder_restart_and_guards() {
  load_libs; mk_tcc 2; write_status; : >"$T/rec_pid"; go_heal; collect_all
  heal_recorder recorder_not_running
  local b s; b="$(lineno "$CALLS" 'launchctl bootout')"; s="$(lineno "$CALLS" 'launchctl bootstrap')"
  [ "$b" -gt 0 ] && [ "$s" -gt "$b" ] && ok || fail "bootout($b) then bootstrap($s)"
  assert_not "$(cat "$CALLS")" "kickstart" "G1"
  : >"$CALLS"; echo 4242 >"$T/rec_pid"; write_status capture_open=true poll_age=900; collect_all
  heal_recorder recorder_hung
  assert_not "$(cat "$CALLS")" "launchctl boot" "G3: hung but capture open -> escalate, no restart"
}

test_c_needs_enrol_restarts_then_escalates() {
  load_libs; mk_tcc 2; write_status state=needs_enrol capture_open=false; go_heal; collect_all
  heal_recorder recorder_needs_enrol
  assert_has "$(cat "$CALLS")" "launchctl bootout" "restart per spec 2.4c"
  assert_has "$(events)" '"action":"escalate"' "and a person is told"
}

test_d_usb_missing_escalates_to_fleet_in_clinic_hours() {
  load_libs; mk_tcc 2; : >"$T/usb.txt"; write_status; go_heal; collect_all
  heal_cycle
  assert_has "$(events)" '"reason":"usb_device_missing"' "escalated"
  assert_has "$(events)" '"target":"fleet"' "to fleet"
  assert_has "$(events)" '"severity":"page"' "paged in clinic hours"
  assert_not "$(cat "$CALLS")" "launchctl boot" "nothing to fix"
}

test_e_retired_escalates_only() {
  load_libs; mk_tcc 2; write_status state=retired capture_open=true; go_heal; collect_all
  heal_cycle
  assert_has "$(events)" '"reason":"server_retired"' "escalated"
  assert_has "$(events)" 'gating-lead,fleet' "targets"
  assert_not "$(cat "$CALLS")" "launchctl boot" "no restart"
}


test_g_drift_repairs() {
  load_libs; mk_tcc 2; printf 'sleep 10\nautorestart 0\n' >"$T/pmset"; rm -f "$RR_PLIST"; write_status capture_open=false; go_heal; collect_all
  heal_drift pmset_drift
  assert_has "$(cat "$CALLS")" "pmset-baseline" "pmset repaired through the helper"
  heal_drift launchagent_missing
  assert_has "$(cat "$CALLS")" "room-recorder install-launch-agent" "agent rewritten by the app"
  assert_has "$(cat "$CALLS")" "launchctl bootstrap" "bootstrapped"
  : >"$T/pub.log"; heal_drift autologin_changed
  assert_has "$(events)" '"reason":"autologin_changed"' "auto-login: alert only"
}

test_g6_three_per_hour_then_escalate_and_stop() {
  load_libs; mk_tcc 2; write_status capture_open=false; : >"$T/rec_pid"; go_heal; collect_all
  local i
  for i in 1 2 3 4 5; do heal_recorder recorder_not_running; done
  assert_eq "$(grep -c 'launchctl bootout' "$CALLS")" "3" "exactly 3 actions"
  assert_eq "$(events | grep -c heal_rate_limited)" "1" "one escalation, then silence"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 3700)); go_heal; collect_all
  heal_recorder recorder_not_running
  assert_eq "$(grep -c 'launchctl bootout' "$CALLS")" "4" "window clears after an hour"
}

test_g8_kill_switch_variants() {
  load_libs; mk_tcc 2; write_status capture_open=false; : >"$T/rec_pid"; collect_all
  go_heal; killswitch_engaged; assert_rc $? 1 "fleet on: clear"
  touch "$FLAG_DIR/heal-off"; killswitch_engaged; assert_rc $? 0 "per-kiosk flag"
  heal_recorder recorder_not_running; assert_not "$(cat "$CALLS")" "launchctl boot" "per-kiosk flag blocks the action"
  rm -f "$FLAG_DIR/heal-off"
  printf 'fleet=off\nmode=heal\n' >"$T/flagout"; flag_fetch; killswitch_engaged; assert_rc $? 0 "fleet off"
  printf 'fleet=on\nmode=heal\n' >"$T/flagout"; echo 1 >"$T/flagrc"; flag_fetch; killswitch_engaged; assert_rc $? 0 "Mini unreachable = OFF"
  echo 0 >"$T/flagrc"; flag_fetch; killswitch_engaged; assert_rc $? 1 "back on"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 300)); killswitch_engaged; assert_rc $? 0 "stale cache = OFF"
}

test_g8_switch_checked_before_every_step() {
  prep_denied
  # flip the switch off right after the helper's UPDATE: the tccd kill and restart must not happen
  root_do() { "$GUARDIAN_ROOT_HELPER" "$@"; local r=$?; [ "$1" = tcc-heal ] && touch "$FLAG_DIR/heal-off"; return $r; }
  heal_tcc
  assert_eq "$(tcc_val)" "2" "the row fix had already landed"
  assert_not "$(cat "$CALLS")" "killall" "aborted before tccd kill"
  assert_not "$(cat "$CALLS")" "launchctl boot" "aborted before restart"
  assert_has "$(events)" "aborted_killswitch" "abort reported"
}

test_g5_root_only_through_the_sudo_path() {
  prep_denied; heal_tcc
  local bad; bad="$(grep '^SUDO' "$CALLS" | grep -v "^SUDO $GUARDIAN_ROOT_HELPER " | wc -l | tr -d ' ')"
  assert_eq "$bad" "0" "every root call is the whitelisted helper"
  GUARDIAN_SUDO="" ; mk_tcc 0; : >"$CALLS"; rm -f "$STATE_DIR/actions"; collect_all
  heal_tcc
  assert_eq "$(tcc_val)" "0" "no sudo path configured: nothing mutated"
  assert_eq "$("$GUARDIAN_ROOT_HELPER" rm-rf / 2>&1; true)" "unknown_verb" "helper has no free-form verb"
}

test_stacked_fix_reruns_from_the_top() {
  prep_denied; touch "$T/boot_fixes_mic"; : >"$T/usb.txt"
  heal_cycle
  assert_eq "$HEAL_PASSES" "2" "after a fix the tree is re-run from the top"
  assert_eq "$(tcc_val)" "2" "permission fixed"
  assert_has "$(events)" 'usb_device_missing' "device layer still escalated"
}

# ---- R2 (refute of 60c50b2) ----

# The refuter's probe: the heal worked, the recorder just logged no "microphone authorized" line. The grant must stay.
test_a_no_log_line_but_authorized_keeps_the_grant() {
  prep_denied; rm -f "$T/boot_ok"; touch "$T/boot_fixes_mic"
  heal_tcc; assert_rc $? 0 "heal succeeds on mic_state=authorized"
  assert_eq "$(tcc_val)" "2" "the row is not reverted to denied"
  assert_not "$(cat "$CALLS")" "tcc-restore" "no restore verb is ever called"
  assert_has "$(events)" '"result":"ok"' "reported ok"
  assert_has "$(events)" 'status:mic_state=authorized' "by the status file"
}

test_a_row_reads_2_after_restart_is_success() {
  prep_denied; rm -f "$T/boot_ok"
  heal_tcc; assert_rc $? 0 "no log line, status still denied, row reads 2: success"
  assert_eq "$(tcc_val)" "2" "grant kept"
  assert_has "$(events)" 'row:auth_value=2' "confirmed by the row"
}

test_a_unconfirmed_escalates_and_never_reverts() {
  prep_denied; rm -f "$T/boot_ok"
  root_do() { "$GUARDIAN_ROOT_HELPER" "$@" | { if [ "$1" = tcc-row ]; then echo "0|4|1"; else cat; fi; }; }
  heal_tcc; assert_rc $? 1 "neither status nor row says authorized"
  assert_eq "$(tcc_val)" "2" "a 2 is never put back to 0"
  assert_has "$(events)" 'unconfirmed_escalated' "escalated"
  assert_has "$(events)" '"severity":"page"' "a person is told"
  assert_not "$(cat "$CALLS")" "tcc-restore" "no revert"
}

test_a_old_backups_pruned_keep_newest_one() {
  prep_denied; heal_tcc
  sqlite3 "$T/TCC.db" "UPDATE access SET auth_value=0 WHERE client='com.evenscribe.room-recorder'"
  : >"$STATE_DIR/tcc_row"; rm -f "$STATE_DIR/actions"; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); go_heal; write_status mic_state=denied capture_open=false state=mic_denied; collect_all
  heal_tcc
  assert_eq "$(ls "$T"/TCC.db.bak-guardian-* | wc -l | tr -d ' ')" "1" "one backup kept while installed"
  assert_has "$(ls "$T"/TCC.db.bak-guardian-*)" "$GUARDIAN_FAKE_NOW" "the newest one"
}

# G2, the refuter's probe: 11:00 IST, capture open, speech-level tape (-20 dBFS), HID idle 1 h, Presence stale -> no Chrome restart.
test_f_g2_speech_on_the_tape_blocks_chrome_restart() {
  load_libs; mk_tcc 2; mk_pcm 3277 3; write_status capture_open=true; echo 3600000000000 >"$T/hid"
  export PRESENCE_FILE="$T/pres"; : >"$PRESENCE_FILE"; touch -t 202610140000 "$PRESENCE_FILE"; go_heal; collect_all
  heal_cycle
  assert_not "$(cat "$CALLS")" "pkill" "speech on the tape: no Chrome restart"
  assert_not "$(cat "$CALLS")" "open -a" "and no reopen"
  assert_eq "$(cat "$STATE_DIR/speech_seen")" "$GUARDIAN_FAKE_NOW" "speech time remembered"
}

test_f_g2_by_day_needs_idle_and_quiet() {
  load_libs; mk_tcc 2; write_status capture_open=false; export PRESENCE_FILE="$T/pres"; : >"$PRESENCE_FILE"; touch -t 202610140000 "$PRESENCE_FILE"
  go_heal; collect_all
  echo 100000000000 >"$T/hid"; heal_chrome; assert_not "$(cat "$CALLS")" "pkill" "idle 100 s by day: no restart"
  echo 700000000000 >"$T/hid"; echo $((GUARDIAN_FAKE_NOW - 300)) >"$STATE_DIR/speech_seen"
  heal_chrome; assert_not "$(cat "$CALLS")" "pkill" "idle 700 s but speech 5 min ago: no restart"
  echo $((GUARDIAN_FAKE_NOW - 700)) >"$STATE_DIR/speech_seen"
  heal_chrome; assert_not "$(cat "$CALLS")" "pkill" "idle 700 s and quiet 11 min but no consult signal (R16): no restart"
  consult_clear
  heal_chrome; assert_has "$(cat "$CALLS")" 'pkill -x Google Chrome' "idle 700 s and quiet 11 min: restart"
  assert_has "$(cat "$CALLS")" 'open -a Google Chrome' "and reopened"
}

test_f_g2_open_capture_without_a_tape_reading_is_not_proof_of_quiet() {
  load_libs; mk_tcc 2; write_status capture_open=true; echo 3600000000000 >"$T/hid"; go_heal; collect_all
  chrome_restart_allowed; assert_rc $? 1 "capture open, rms unknown: blocked by day"
  write_status capture_open=false; collect_all; consult_clear
  chrome_restart_allowed; assert_rc $? 0 "no capture, idle 1 h, no speech: allowed"
}

test_f_g2_night_window_boundaries() {
  load_libs; mk_tcc 2; write_status capture_open=true; echo 100000000000 >"$T/hid"
  export PRESENCE_FILE="$T/pres"; : >"$PRESENCE_FILE"; touch -t 202610140000 "$PRESENCE_FILE"
  GUARDIAN_FAKE_NOW="$(ist_epoch 21:34)"; go_heal; collect_all
  heal_chrome; assert_not "$(cat "$CALLS")" "pkill" "21:34 busy: no restart (fresh switch, so this is G2 and not a stale cache)"
  GUARDIAN_FAKE_NOW="$(ist_epoch 21:36)"; go_heal; : >"$STATE_DIR/actions"; collect_all
  heal_chrome; assert_has "$(cat "$CALLS")" "pkill" "after 21:35 IST: restart even if not idle"
  : >"$CALLS"; GUARDIAN_FAKE_NOW="$(ist_epoch 05:59)"; go_heal; : >"$STATE_DIR/actions"; collect_all
  heal_chrome; assert_has "$(cat "$CALLS")" "pkill" "05:59 still night"
  : >"$CALLS"; GUARDIAN_FAKE_NOW="$(ist_epoch 06:01)"; go_heal; : >"$STATE_DIR/actions"; collect_all
  heal_chrome; assert_not "$(cat "$CALLS")" "pkill" "06:01 is day again"
}

# G8: the kill switch is checked before an action starts and never between its two halves.
test_g8_bootout_is_always_followed_by_bootstrap() {
  load_libs; mk_tcc 2; write_status capture_open=false; : >"$T/rec_pid"; go_heal; collect_all
  gsleep() { touch "$FLAG_DIR/heal-off"; }   # the switch goes off during the settle
  heal_recorder recorder_not_running
  assert_eq "$(grep -c 'launchctl bootout' "$CALLS")" "1" "bootout ran"
  assert_eq "$(grep -c 'launchctl bootstrap' "$CALLS")" "1" "and so did bootstrap"
}

test_g8_pkill_chrome_is_always_followed_by_open() {
  load_libs; mk_tcc 2; write_status capture_open=false; GUARDIAN_FAKE_NOW="$(ist_epoch 21:36)"; go_heal; collect_all
  gsleep() { touch "$FLAG_DIR/heal-off"; }
  heal_chrome
  assert_has "$(cat "$CALLS")" "pkill" "Chrome killed"
  assert_has "$(cat "$CALLS")" "open -a Google Chrome" "and reopened"
}

test_g8_a_failed_bootstrap_is_retried_once() {
  load_libs; mk_tcc 2; write_status capture_open=false; : >"$T/rec_pid"; go_heal; collect_all
  printf '#!/bin/bash\necho "launchctl $*" >>"$CALLS"\n[ "$1" = bootstrap ] && [ "$(grep -c "launchctl bootstrap" "$CALLS")" = 1 ] && exit 5\nexit 0\n' >"$T/bin/launchctl"
  recorder_restart; assert_rc $? 0 "second bootstrap works"
  assert_eq "$(grep -c 'launchctl bootstrap' "$CALLS")" "2" "retried once"
}

test_g8_switch_off_before_start_means_no_bootout() {
  load_libs; mk_tcc 2; write_status capture_open=false; : >"$T/rec_pid"; go_heal; collect_all
  touch "$FLAG_DIR/heal-off"; recorder_restart
  assert_not "$(cat "$CALLS")" "launchctl boot" "nothing started, nothing half done"
}

# G6 window is an hour, not a minute.
test_g6_window_is_an_hour() {
  load_libs; mk_tcc 2; write_status capture_open=false; : >"$T/rec_pid"; go_heal; collect_all
  local i
  for i in 1 2 3; do heal_recorder recorder_not_running; done
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 120)); go_heal; collect_all
  heal_recorder recorder_not_running
  assert_eq "$(grep -c 'launchctl bootout' "$CALLS")" "3" "two minutes later the cap still holds"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 3000)); go_heal; collect_all
  heal_recorder recorder_not_running
  assert_eq "$(grep -c 'launchctl bootout' "$CALLS")" "3" "52 minutes later it still holds"
}

# The flags are fetched every 10 s, not more and not less often.
test_flag_poll_interval_is_10_s() {
  load_libs; export GUARDIAN_FLAG_CMD='echo x >>"$T/fcount"; printf "fleet=on\nmode=heal\n"'
  flag_poll; assert_eq "$(wc -l <"$T/fcount" | tr -d ' ')" "1" "first poll fetches"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 5)); flag_poll
  assert_eq "$(wc -l <"$T/fcount" | tr -d ' ')" "1" "5 s later: no fetch"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 6)); flag_poll
  assert_eq "$(wc -l <"$T/fcount" | tr -d ' ')" "2" "11 s later: fetch"
  assert_eq "$FLAG_FETCH_S" "10" "the interval"
}
