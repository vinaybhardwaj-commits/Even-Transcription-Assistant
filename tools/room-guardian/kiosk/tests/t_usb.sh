#!/bin/bash
# 2.4 d' USB-C port power-off -> reboot, and the dual-form consult_open control parse.
# /sbin/shutdown, /usr/bin/log, ioreg and the clock are ALWAYS faked (lib.sh: GUARDIAN_SHUTDOWN_BIN, GUARDIAN_LOG_BIN, fakes on PATH, GUARDIAN_FAKE_NOW). Nothing here reboots anything.
# shellcheck disable=SC2034,SC2154

SD_TOK="start_""day"
U_CLEAR='{"consult_open": {"opd9": false}, "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
U_TRUE='{"consult_open": {"opd9": true}, "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
U_OLD='{"kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
U_OTHER='{"consult_open": {"opd1": false}, "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
U_BAD='{"consult_open": "no", "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}'
U_SHADOW='{"consult_open": {"opd9": false}, "kill": false, "modes": {"opd9": "shadow"}, "ts": @TS@}'
U_KILL='{"consult_open": {"opd9": false}, "kill": true, "modes": {"opd9": "heal"}, "ts": @TS@}'

# usb_ctl <payload with @TS@> [age_s]: store it as the control subscriber would (received <age> s ago, default 1), then fetch.
usb_ctl() {
  local p="${1/@TS@/$GUARDIAN_FAKE_NOW}" age="${2:-1}"
  mkdir -p "$STATE_DIR"
  { printf '%s\n' "$((GUARDIAN_FAKE_NOW - age))"; printf '%s\n' "$p"; } >"$STATE_DIR/control.last"
  rm -f "$STATE_DIR/control_latch" "$STATE_DIR/control_state"
  export GUARDIAN_CONTROL_SUB_CMD='true'
  flag_fetch
}

# usb_logline <age_s> [port]: one CC cable-detect line, <age> s before the fake clock, in the Mac's local time (what /usr/bin/log prints). A header line first, as the real tool prints.
usb_logline() {
  local e=$((GUARDIAN_FAKE_NOW - $1)) p="${2:-usb-drd3-port-hs@03100000}"
  { printf 'Filtering the log data using "process == kernel"\n'
    printf '%s.104 Df  kernel[0:694] [com.apple.usb:all] %s: AppleUSBHostPort::cableChangeOccurred: powering off\n' "$(date -r "$e" '+%Y-%m-%d %H:%M:%S')" "$p"; } >"$T/log.txt"
}

# a clean scenario: C270 absent, fresh log line, HID idle 1000 s, no state, no calls
usb_reset() {
  rm -rf "$STATE_DIR/once"
  rm -f "$STATE_DIR"/usb_absent "$STATE_DIR"/cc_probe.neg "$STATE_DIR"/cc_probe.out "$STATE_DIR"/usb-reboot "$STATE_DIR"/usb-reboot.tmp "$STATE_DIR"/usb-reboot-lock \
    "$STATE_DIR"/usb-reboot-reset "$STATE_DIR"/actions "$STATE_DIR"/flags.cache "$STATE_DIR"/flag_last "$STATE_DIR"/control.last "$STATE_DIR"/control_latch "$STATE_DIR"/control_state
  rmdir "$STATE_DIR/usb-reboot.tmp" 2>/dev/null
  : >"$CALLS"; : >"$T/pub.log"; USB_REBOOT_ISSUED=0
  GUARDIAN_FAKE_NOW="$(ist_epoch 11:00)"; export GUARDIAN_FAKE_NOW
  : >"$T/usb.txt"; : >"$T/engine.txt"; echo 1000000000000 >"$T/hid"; rm -f "$T/log_rc" "$T/log_sleep"
  usb_logline 120
  mk_fakes   # restore ioreg and the rest after a scenario that replaced one
  mk_tcc 2; write_status
}

# usb_go <payload>: tick 1, 10 s later tick 2 (C270 absent both times), then the heal cycle.
usb_go() {
  usb_ctl "$1"; collect_all
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW
  usb_ctl "$1"; collect_all
  heal_cycle >/dev/null 2>&1
}

n_reboot_calls() { grep -c 'guardian-root.sh reboot$' "$CALLS"; }
n_shutdown() { grep -c '^SHUTDOWN ' "$CALLS"; }

test_usb_all_guards_true_heal_one_reboot_state_first() {
  load_libs; usb_reset
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "1" "exactly one reboot verb call"
  assert_eq "$(n_shutdown)" "1" "exactly one (fake) shutdown"
  assert_has "$(cat "$CALLS")" '^SHUTDOWN -r now$' "shutdown -r now, nothing else"
  assert_has "$(cat "$CALLS")" 'SHUTDOWN_STATE_WRITTEN=yes' "the state file existed before the shutdown ran"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" "^date=$(ist_date)$" "state holds the IST date"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^epoch=[0-9]*$' "state holds the epoch"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^recorder_pid=4242$' "state holds the recorder pid"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^coreaudiod_pid=9999$' "state holds the coreaudiod pid"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^port=usb-drd3-port-hs@03100000$' "state holds the port name only"
  assert_has "$(events)" '"action":"kiosk_reboot","layer":"usb","reason":"usb_power_off"' "heal event: kiosk_reboot, layer usb, kind usb_power_off"
  assert_has "$(events)" '"guards":{"usb_absent_ticks":2,"cc_power_off_age_s":13[0-9],"hid_idle_s":1000,"consult_hold":"clear","port":"usb-drd3-port-hs@03100000"}' "guards in the event"
  assert_has "$(events)" '"boot_age_s":{"before":100000,"after":null}' "boot_age_s before"
  assert_has "$(events)" '"recorder_pid":{"before":4242,"after":null}' "recorder_pid before"
  assert_has "$(events)" '"shadow":false' "a real action, not shadow"
  assert_not "$(cat "$CALLS")" "$SD_TOK\\|restart_engine\\|tapewriter record" "the kiosk sends no room command"
  # a second qualifying event the same IST day: escalate, no second reboot
  USB_REBOOT_ISSUED=0; : >"$CALLS"; : >"$T/pub.log"; rm -f "$STATE_DIR/usb_absent" "$STATE_DIR/cc_probe.neg"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 300)); usb_logline 100
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "second event the same day: no reboot"
  assert_has "$(events)" '"reason":"usb_power_off_recurring"' "usb_power_off_recurring escalated"
}

test_usb_each_guard_false_gives_no_reboot() {
  load_libs
  local c n
  for c in one_tick no_log log_timeout log_error hid_low hid_unreadable hold_true hold_old hold_other hold_malformed kill shadow stale_control today lock state_garbage; do
    usb_reset
    local payload="$U_CLEAR" age=1
    case "$c" in
      one_tick) usb_ctl "$payload"; collect_all; heal_cycle >/dev/null 2>&1; n="$(n_reboot_calls)"; assert_eq "$n" "0" "$c: no reboot"; assert_not "$(cat "$CALLS")" '^LOG ' "$c: the log is not even read below 2 ticks"; continue ;;
      no_log) : >"$T/log.txt" ;;
      log_timeout) echo 5 >"$T/log_sleep" ;;
      log_error) echo 1 >"$T/log_rc" ;;
      hid_low) echo 599000000000 >"$T/hid" ;;
      hid_unreadable) printf '#!/bin/bash\ncase "$*" in\n  *IOUSBHostDevice*) cat "$T/usb.txt" ;;\n  *IOAudioEngine*) cat "$T/engine.txt" ;;\nesac\n' >"$T/bin/ioreg" ;;
      hold_true) payload="$U_TRUE" ;;
      hold_old) payload="$U_OLD" ;;
      hold_other) payload="$U_OTHER" ;;
      hold_malformed) payload="$U_BAD" ;;
      kill) payload="$U_KILL" ;;
      shadow) payload="$U_SHADOW" ;;
      stale_control) payload="$U_CLEAR"; age=91 ;;
      today) printf 'date=%s\nepoch=1\nrecorder_pid=1\ncoreaudiod_pid=1\nboot_age_s=1\nport=x\nverify=healed_pending\n' "$(ist_date)" >"$STATE_DIR/usb-reboot" ;;
      lock) printf '%s\n' "$((GUARDIAN_FAKE_NOW - 3600))" >"$STATE_DIR/usb-reboot-lock" ;;
      state_garbage) echo garbage >"$STATE_DIR/usb-reboot" ;;
    esac
    usb_ctl "$payload" "$age"; collect_all
    GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW
    usb_ctl "$payload" "$age"; collect_all
    heal_cycle >/dev/null 2>&1
    assert_eq "$(n_reboot_calls)" "0" "$c: no root reboot call"
    assert_eq "$(n_shutdown)" "0" "$c: no shutdown"
    assert_not "$(cat "$CALLS")" 'SUDO .*reboot' "$c: no sudo reboot"
    [ "$c" = log_timeout ] && sleep 1
  done
  sleep 2   # let the one fake log that outlived its 4 s cap finish
}

test_usb_absence_without_log_line_stays_rung_d() {
  load_libs; usb_reset; : >"$T/log.txt"
  usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_has "$(fault_tree)" '^usb|usb_device_missing|' "no log line: usb_device_missing"
  assert_not "$(fault_tree)" 'usb_power_off' "no log line: not d'"
  usb_reset; usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_has "$(fault_tree)" '^usb|usb_power_off|.*usb_absent_ticks=2 cc_power_off_age_s=13[0-9] port=usb-drd3-port-hs@03100000' "line + 2 ticks: d' with the port"
  # a line older than 15 min does not count
  usb_reset; usb_logline 1000; usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_has "$(fault_tree)" 'usb_device_missing' "a line older than 15 min: rung d"
  # the device back resets the count
  usb_reset; usb_ctl "$U_CLEAR"; collect_all; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW; collect_all
  assert_eq "$S_usb_ticks" "0" "present resets the count"
}

test_usb_log_probe_command_is_pinned_and_fixed() {
  load_libs; usb_reset
  usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  local l; l="$(grep '^LOG ' "$CALLS" | head -n1)"
  assert_has "$l" '^LOG show --last 15m --style compact --predicate process == "kernel" AND subsystem == "com.apple.usb:all" AND eventMessage CONTAINS "AppleUSBHostPort::cableChangeOccurred: powering off"$' "fixed predicate, 15 m window"
  assert_eq "$(grep -c '^LOG ' "$CALLS")" "1" "one probe"
  # run mode pins the reader to /usr/bin/log whatever the environment says; library tests may re-point it
  assert_eq "$(env -i HOME="$HOME" G_RUNMODE=1 GUARDIAN_LOG_BIN=/tmp/evil /bin/bash -c '. "$0"; echo "$G_LOG"' "$KDIR/lib/common.sh" 2>/dev/null)" "/usr/bin/log" "run mode: G_LOG is /usr/bin/log whatever the environment says"
  assert_has "$(env -i HOME="$HOME" G_RUNMODE=1 /bin/bash -c '. "$0"; declare -p G_LOG' "$KDIR/lib/common.sh" 2>/dev/null)" 'declare -r' "run mode: G_LOG is readonly"
  assert_has "$(grep -n 'g_clean_exec "\$G_LOG"' "$KDIR/lib/collect.sh")" 'run_capped' "the probe runs through the clean-env path"
  assert_has "$(grep -n 'root_do reboot' "$KDIR/lib/heal.sh")" 'root_do reboot' "the reboot verb runs through root_do (clean env)"
}

test_usb_shadow_and_kill_are_would_do_and_helper_never_called() {
  load_libs
  local c
  for c in shadow kill hold_true hold_old; do
    usb_reset
    case "$c" in shadow) usb_go "$U_SHADOW" ;; kill) usb_go "$U_KILL" ;; hold_true) usb_go "$U_TRUE" ;; hold_old) usb_go "$U_OLD" ;; esac
    assert_eq "$(n_reboot_calls)" "0" "$c: the root helper is never called with reboot"
    assert_not "$(cat "$CALLS")" 'SUDO .*reboot' "$c: the root helper is never asked to reboot"
    assert_not "$(cat "$CALLS")" '^SHUTDOWN' "$c: no shutdown"
    assert_has "$(events)" 'WOULD-DO' "$c: would_do reported"
    assert_has "$(events)" '"shadow":true' "$c: report-only"
    [ ! -e "$STATE_DIR/usb-reboot" ] && ok || fail "$c: the day budget is not spent by a would_do"
    [ ! -s "$STATE_DIR/actions" ] && ok || fail "$c: a would_do is not counted against the 3/h cap"
  done
}

test_usb_kill_flip_between_the_two_reads_gives_zero_calls() {
  load_libs; usb_reset
  eval "usb_state_write_real() $(declare -f usb_state_write | sed 1d)"
  # the flip happens right after the state is written and read back: after the first kill read (act_begin), before the second (act_step)
  usb_state_write() { usb_state_write_real "$@" || return 1; usb_ctl "$U_KILL"; return 0; }
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "kill flipped between the reads: 0 root calls"
  assert_eq "$(n_shutdown)" "0" "kill flipped between the reads: 0 shutdown"
  assert_has "$(events)" '"result":"aborted_' "the abort is reported"
  assert_eq "$(usb_budget_state)" "none" "the aborted attempt does not spend the day's budget"
}

test_usb_hold_flip_between_the_two_reads_gives_zero_calls() {
  load_libs; usb_reset
  eval "usb_state_write_real() $(declare -f usb_state_write | sed 1d)"
  usb_state_write() { usb_state_write_real "$@" || return 1; usb_ctl "$U_TRUE"; return 0; }
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "hold set between the reads: 0 root calls"
  assert_eq "$(usb_budget_state)" "none" "budget not spent"
}

test_usb_failed_state_write_means_no_reboot() {
  load_libs; usb_reset
  mkdir -p "$STATE_DIR/usb-reboot.tmp"
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "state write failed: no reboot"
  assert_has "$(events)" 'state_write_failed' "reported"
  rmdir "$STATE_DIR/usb-reboot.tmp"
  # a read-back that differs also fails
  usb_reset
  eval "usb_state_write_real() $(declare -f usb_state_write | sed 1d)"
  usb_state_write() { usb_state_write_real "$@"; echo tampered >>"$USB_STATE"; return 1; }
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "read-back mismatch: no reboot"
}

test_usb_verify_healed_pending_then_failed_and_lock() {
  load_libs; usb_reset
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "1" "reboot issued"
  # the kiosk comes back: boot 40 s old, device present, recorder running with one tapewriter
  : >"$CALLS"; : >"$T/pub.log"; USB_REBOOT_ISSUED=0
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 120)); export GUARDIAN_FAKE_NOW; export FAKE_BOOT_AGE=40
  printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; echo 7777 >"$T/rec_pid"; echo 5001 >"$T/tapewriters"
  usb_ctl "$U_CLEAR"; collect_all; heal_cycle >/dev/null 2>&1
  assert_has "$(events)" '"action":"kiosk_reboot".*"result":"healed_pending"' "healed_pending after the reboot"
  assert_has "$(events)" '"boot_age_s":{"before":100000,"after":40}' "boot_age_s before and after"
  assert_has "$(events)" '"recorder_pid":{"before":4242,"after":7777}' "recorder_pid before and after"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^verify=healed_pending$' "state moved on"
  assert_not "$(cat "$CALLS")" "$SD_TOK" "no day-start command from the kiosk"
  [ ! -e "$USB_LOCK" ] && ok || fail "healed: no lock"
  # a failed verify: no reboot seen within 10 min -> usb_reboot_failed and a 24 h lock
  usb_reset; unset FAKE_BOOT_AGE
  usb_go "$U_CLEAR"
  : >"$CALLS"; : >"$T/pub.log"; USB_REBOOT_ISSUED=0
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 700)); export GUARDIAN_FAKE_NOW
  usb_ctl "$U_CLEAR"; collect_all; heal_cycle >/dev/null 2>&1
  assert_has "$(events)" '"reason":"usb_reboot_failed"' "usb_reboot_failed escalated"
  [ -s "$USB_LOCK" ] && ok || fail "lock written"
  assert_eq "$(n_reboot_calls)" "0" "no second reboot"
  # locked: a new qualifying event does nothing, even on a later day
  rm -f "$STATE_DIR/usb_absent" "$STATE_DIR/cc_probe.neg"
  : >"$T/usb.txt"; : >"$T/engine.txt"; rm -f "$STATE_DIR/once"/*
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 3 * 3600)); export GUARDIAN_FAKE_NOW; usb_logline 100; echo 1000000000000 >"$T/hid"
  printf 'date=00000000\nverify=failed\n' >"$STATE_DIR/usb-reboot"
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "locked rung: no reboot"
  # the fleet hand-reset file (newer than the lock) clears it
  local le; le="$(sed -n 1p "$USB_LOCK")"
  : >"$USB_RESET"; touch -t "$(date -j -f %s "$((le + 600))" +%Y%m%d%H%M.%S)" "$USB_RESET"
  rm -f "$STATE_DIR/usb_absent" "$STATE_DIR/cc_probe.neg"; rm -rf "$STATE_DIR/once"; : >"$CALLS"; USB_REBOOT_ISSUED=0
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "1" "hand-reset file clears the lock"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" 'cleared by the hand-reset file' "the clear is audited"
}

test_usb_root_helper_reboot_verb_is_exact() {
  local h="$KDIR/bin/guardian-root.sh" out rc
  : >"$CALLS"
  out="$("$h" reboot 2>&1)"; rc=$?
  assert_rc "$rc" 0 "reboot verb"
  assert_eq "$(grep -c '^SHUTDOWN -r now$' "$CALLS")" "1" "runs exactly shutdown -r now"
  : >"$CALLS"
  for a in "now" "-r" "-h now" "reboot" ""; do
    if [ -z "$a" ]; then out="$("$h" reboot "" 2>&1)"; rc=$?; else out="$("$h" reboot $a 2>&1)"; rc=$?; fi
    assert_rc "$rc" 2 "reboot with extra argument [$a] is refused"
  done
  assert_eq "$(grep -c '^SHUTDOWN' "$CALLS")" "0" "no shutdown on a refused call"
  # the test seam is dead as root and outside test mode
  assert_has "$(grep -n 'GUARDIAN_SHUTDOWN_BIN' "$h")" 'id -u.*!= "0".*GUARDIAN_ROOT_TESTMODE' "the shutdown seam needs non-root + test mode"
  unset GUARDIAN_ROOT_TESTMODE
  : >"$CALLS"
  # without test mode the real path is used; prove it by pointing PATH nowhere and checking the fake is NOT run (the real /sbin/shutdown is never started here: sandboxed by refusing before)
  assert_has "$(grep -n 'sd=/sbin/shutdown' "$h")" 'sd=/sbin/shutdown' "default is the absolute /sbin/shutdown"
}

test_usb_control_old_and_new_forms_parse_identically() {
  load_libs
  export GUARDIAN_CONTROL_SUB_CMD='true'
  local old='{"kill": false, "modes": {"opd9": "heal", "z": "shadow"}, "ts": @TS@}' new='{"consult_open": {"opd9": false, "z": true}, "kill": false, "modes": {"opd9": "heal", "z": "shadow"}, "ts": @TS@}'
  usb_ctl "$old"; control_parse; assert_eq "$CTRL_FLEET/$CTRL_MODE/$CTRL_WHY/$CTRL_HOLD" "on/heal/ok/set" "old form: parses, hold SET"
  usb_ctl "$new"; control_parse; assert_eq "$CTRL_FLEET/$CTRL_MODE/$CTRL_WHY/$CTRL_HOLD" "on/heal/ok/clear" "new form: parses, hold CLEAR"
  usb_ctl '{"kill": true, "modes": {"opd9": "heal"}, "ts": @TS@}'; control_parse; assert_eq "$CTRL_FLEET/$CTRL_WHY/$CTRL_HOLD" "unreachable/kill/set" "old form kill"
  usb_ctl '{"consult_open": {"opd9": false}, "kill": true, "modes": {"opd9": "heal"}, "ts": @TS@}'; control_parse; assert_eq "$CTRL_FLEET/$CTRL_WHY/$CTRL_HOLD" "unreachable/kill/set" "new form kill: killed, hold SET"
  usb_ctl '{"consult_open": {"opd9": false}, "kill": false, "modes": {"opd9": "shadow"}, "ts": @TS@}'; control_parse; assert_eq "$CTRL_MODE/$CTRL_HOLD" "shadow/clear" "new form shadow"
  usb_ctl '{"consult_open": {}, "kill": false, "modes": {}, "ts": @TS@}'; control_parse; assert_eq "$CTRL_FLEET/$CTRL_MODE/$CTRL_HOLD" "on/shadow/set" "empty consult_open: room absent = SET"
  # stale and skew behave the same in the new form
  usb_ctl "$new" 91; control_parse; assert_eq "$CTRL_WHY/$CTRL_HOLD" "stale/set" "new form stale"
  usb_ctl '{"consult_open": {"opd9": false}, "kill": false, "modes": {"opd9": "heal"}, "ts": 4102444800}'; control_parse; assert_eq "$CTRL_WHY/$CTRL_HOLD" "skew/set" "new form skew"
  # consult_hold_clear
  usb_ctl "$new"; consult_hold_clear; assert_rc $? 0 "consult_hold_clear on a fresh clear payload"
  usb_ctl "$old"; consult_hold_clear; assert_rc $? 1 "old form: hold"
  GUARDIAN_CONTROL_SUB_CMD=""; usb_ctl "$new" >/dev/null 2>&1; GUARDIAN_CONTROL_SUB_CMD=""; consult_hold_clear; assert_rc $? 1 "no control command: hold"
}

test_usb_control_every_malformed_consult_open_is_set_and_kill_modes_unaffected() {
  load_libs
  export GUARDIAN_CONTROL_SUB_CMD='true'
  local tail=', "kill": false, "modes": {"opd9": "heal"}, "ts": @TS@}' c i
  local -a bad=(
    '"no"' '[]' 'null' '5' 'true' '{"opd9": "false"}' '{"opd9": 0}' '{"opd9": null}' '{"opd9": false,}' '{"OPD9": false}' '{"opd9": False}'
    '{"opd9": false, "opd9": false}' '{"opd9": true, "opd9": false}' '{"z": false, "opd9": false}' '{"opd9":false}' '{opd9: false}' '{"opd9": false'
    '{"opd9": false} x' '{"opd9": false}}' '{"opd 9": false}' '{"opd9": false, "a": 1}' '{"": false}' '{"opd9": false} , {}'
  )
  for c in "${bad[@]}"; do
    usb_ctl "{\"consult_open\": $c$tail"; control_parse
    assert_eq "$CTRL_FLEET/$CTRL_MODE/$CTRL_HOLD" "on/heal/set" "malformed consult_open [$c]: hold SET, kill and modes unaffected"
  done
  # more than 64 rooms is oversize = SET (65 ascending keys)
  local big="" k
  for i in $(seq 1 65); do k="$(printf 'r%03d' "$i")"; big="$big\"$k\": false, "; done
  big="{${big}\"zz\": false}"
  usb_ctl "{\"consult_open\": $big$tail"; control_parse
  assert_eq "$CTRL_FLEET/$CTRL_MODE/$CTRL_HOLD" "on/heal/set" "66 rooms in consult_open: SET, modes unaffected"
  # a malformed consult_open with kill=true is still killed
  usb_ctl '{"consult_open": "no", "kill": true, "modes": {"opd9": "heal"}, "ts": @TS@}'; control_parse
  assert_eq "$CTRL_FLEET/$CTRL_WHY/$CTRL_HOLD" "unreachable/kill/set" "malformed + kill: killed"
  # a bad kill/modes/ts in the new form is killed, whatever consult_open says
  for c in '"kill": maybe, "modes": {"opd9": "heal"}, "ts": @TS@}' '"kill": false, "modes": {"opd9": "go"}, "ts": @TS@}' '"kill": false, "modes": {"opd9": "heal"}, "ts": 0}' '"modes": {"opd9": "heal"}, "kill": false, "ts": @TS@}'; do
    usb_ctl "{\"consult_open\": {\"opd9\": false}, $c"; control_parse
    assert_eq "$CTRL_FLEET/$CTRL_HOLD" "unreachable/set" "bad kill/modes/ts in the new form [$c]: killed"
  done
  # a consult_open key out of the old position is not either form
  usb_ctl '{"kill": false, "consult_open": {"opd9": false}, "modes": {"opd9": "heal"}, "ts": @TS@}'; control_parse
  assert_eq "$CTRL_FLEET/$CTRL_HOLD" "unreachable/set" "consult_open not first: killed"
}

test_usb_control_64_rooms_parse_and_exactly_one_false_is_clear() {
  load_libs
  export GUARDIAN_CONTROL_SUB_CMD='true'
  local i k co="" mo=""
  for i in $(seq 1 64); do k="$(printf 'r%03d' "$i")"; co="$co\"$k\": true, "; mo="$mo\"$k\": \"shadow\", "; done
  co="${co%, }"; mo="${mo%, }"
  # this room is r064 in the 64-room map: false there only
  co="${co/\"r064\": true/\"r064\": false}"
  export GUARDIAN_ROOM=r064
  usb_ctl "{\"consult_open\": {$co}, \"kill\": false, \"modes\": {$mo}, \"ts\": @TS@}"; control_parse
  assert_eq "$CTRL_FLEET/$CTRL_HOLD" "on/clear" "64 rooms, own key false once: CLEAR"
  export GUARDIAN_ROOM=r001
  usb_ctl "{\"consult_open\": {$co}, \"kill\": false, \"modes\": {$mo}, \"ts\": @TS@}"; control_parse
  assert_eq "$CTRL_FLEET/$CTRL_HOLD" "on/set" "64 rooms, own key true: SET"
  export GUARDIAN_ROOM=opd9
}

test_usb_static_c3_and_version() {
  assert_eq "$(grep -rn -E "start_""recording|stop_""recording|scribe_""room_command|rec_""start|rec_""stop|$SD_TOK" "$KDIR"/bin "$KDIR"/lib "$KDIR"/install.sh "$KDIR"/uninstall.sh | wc -l | tr -d ' ')" "0" "C3 grep (with the day-start command) over the kiosk tree is 0"
  assert_has "$(cat "$KDIR/lib/common.sh")" 'GUARDIAN_VERSION="c1-0.4.0-d1"' "version"
  assert_eq "$(cat "$KDIR/lib/heal.sh" "$KDIR/lib/collect.sh" "$KDIR/lib/faulttree.sh" "$KDIR/bin/guardian.sh" | grep -v '^[[:space:]]*#' | grep -c 'shutdown')" "0" "the agent code never names shutdown: only the root helper does"
  assert_eq "$(grep -n 'shutdown' "$KDIR/bin/guardian-root.sh" | grep -v '^[0-9]*:#' | wc -l | tr -d ' ')" "1" "the helper's only code line naming shutdown is the absolute default path"
}
