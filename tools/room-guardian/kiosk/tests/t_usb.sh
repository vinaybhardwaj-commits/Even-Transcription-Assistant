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
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW
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
  assert_has "$(events)" '"guards":{"usb_absent_ticks":2,"cc_power_off_age_s":14[0-9],"hid_idle_s":1000,"consult_hold":"clear","port":"usb-drd3-port-hs@03100000"}' "guards in the event"
  assert_has "$(events)" '"boot_age_s":{"before":100000,"after":null}' "boot_age_s before"
  assert_has "$(events)" '"recorder_pid":{"before":4242,"after":null}' "recorder_pid before"
  assert_has "$(events)" '"shadow":false' "a real action, not shadow"
  assert_not "$(cat "$CALLS")" "$SD_TOK\\|restart_engine\\|tapewriter record" "the kiosk sends no room command"
  # S1: the agent that issued the reboot does nothing more, whatever the tick sees
  : >"$CALLS"; : >"$T/pub.log"; rm -f "$STATE_DIR/usb_absent" "$STATE_DIR/cc_probe.neg" "$STATE_DIR/once"/*
  usb_go "$U_CLEAR"
  assert_eq "$(events | wc -l | tr -d ' ')" "0" "S1: after USB_REBOOT_ISSUED=1 heal_cycle emits nothing for the agent's lifetime"
  assert_eq "$(n_reboot_calls)" "0" "S1: no second reboot call"
  # a second qualifying event the same IST day (the first reboot proven healed): escalate, no second reboot
  usb_state_set_verify healed_pending
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
    GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW
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
  usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_has "$(fault_tree)" '^usb|usb_device_missing|' "no log line: usb_device_missing"
  assert_not "$(fault_tree)" 'usb_power_off' "no log line: not d'"
  usb_reset; usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_has "$(fault_tree)" '^usb|usb_power_off|.*usb_absent_ticks=2 cc_power_off_age_s=14[0-9] port=usb-drd3-port-hs@03100000' "line + 2 ticks: d' with the port"
  # a line older than 15 min does not count
  usb_reset; usb_logline 1000; usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_has "$(fault_tree)" 'usb_device_missing' "a line older than 15 min: rung d"
  # the device back resets the count
  usb_reset; usb_ctl "$U_CLEAR"; collect_all; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW; collect_all
  assert_eq "$S_usb_ticks" "0" "present resets the count"
}

test_usb_log_probe_command_is_pinned_and_fixed() {
  load_libs; usb_reset
  usb_ctl "$U_CLEAR"; collect_all; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  local l; l="$(grep '^LOG ' "$CALLS" | head -n1)"
  assert_has "$l" '^LOG show --last 15m --style compact --predicate process == "kernel" AND processID == 0 AND subsystem == "com.apple.usb:all" AND eventMessage CONTAINS "AppleUSBHostPort::cableChangeOccurred: powering off"$' "fixed predicate, 15 m window"
  assert_has "$l" 'process == "kernel" AND processID == 0 AND subsystem' "S8: processID == 0 in the probe"
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
  printf 'date=00000000\nepoch=1\nverify=failed\n' >"$STATE_DIR/usb-reboot"   # R15b N1: a real failed-verify state carries its epoch (usb_state_set_verify edits a written state)
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
  assert_has "$(grep -n 'GUARDIAN_SHUTDOWN_BIN' "$h")" '\$EUID. -ne 0.*GUARDIAN_ROOT_TESTMODE' "the shutdown seam needs non-root (EUID) + test mode"
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
  assert_has "$(cat "$KDIR/lib/common.sh")" 'GUARDIAN_VERSION="c1-0.4.4-r16"' "version"
  assert_has "$(grep -n 'USB_LOG_PREDICATE' "$KDIR/lib/common.sh" | head -n1)" 'process == "kernel" AND processID == 0 AND subsystem' "S8: predicate pins processID == 0"
  assert_eq "$(cat "$KDIR/lib/heal.sh" "$KDIR/lib/collect.sh" "$KDIR/lib/faulttree.sh" "$KDIR/bin/guardian.sh" | grep -v '^[[:space:]]*#' | grep -c 'shutdown')" "0" "the agent code never names shutdown: only the root helper does"
  assert_eq "$(grep -n 'shutdown' "$KDIR/bin/guardian-root.sh" | grep -v '^[0-9]*:#' | wc -l | tr -d ' ')" "1" "the helper's only code line naming shutdown is the absolute default path"
}

# ---- d2 ----
usb_esc() { # label: the rung d page (escalated, usb_device_missing, layer usb) is in the events
  assert_has "$(events | grep '"reason":"usb_device_missing"')" '"layer":"usb".*"result":"escalated"' "$1: usb_device_missing escalated (M1)"
}

test_usb_m1_every_noreboot_exit_still_escalates_device_missing() {
  load_libs
  local c
  for c in shadow old hold_true hold_missing kill g6cap; do
    usb_reset
    case "$c" in
      shadow) usb_go "$U_SHADOW" ;;
      old) usb_go "$U_OLD" ;;
      hold_true) usb_go "$U_TRUE" ;;
      hold_missing) usb_go "$U_OTHER" ;;
      kill) usb_go "$U_KILL" ;;
      g6cap) for _ in 1 2 3; do printf '%s x:y\n' "$GUARDIAN_FAKE_NOW" >>"$STATE_DIR/actions"; done; usb_go "$U_CLEAR" ;;
    esac
    assert_eq "$(n_reboot_calls)" "0" "$c: no reboot"
    usb_esc "$c"
    assert_not "$(events)" '"kind"' "$c: no kind key on any heal line"
  done
  # the would_do stays alongside the page
  usb_reset; usb_go "$U_SHADOW"; assert_has "$(events)" 'WOULD-DO' "shadow: would_do kept"
  # a state-write failure, the abort path, the device back, an ist_date failure
  usb_reset; mkdir -p "$STATE_DIR/usb-reboot.tmp"; usb_go "$U_CLEAR"; usb_esc "state write failed"; rmdir "$STATE_DIR/usb-reboot.tmp"
  usb_reset
  eval "usb_state_write_real() $(declare -f usb_state_write | sed 1d)"
  usb_state_write() { usb_state_write_real "$@" || return 1; usb_ctl "$U_KILL"; return 0; }
  usb_go "$U_CLEAR"; usb_esc "abort path"; assert_eq "$(n_reboot_calls)" "0" "abort: no reboot"
  eval "usb_state_write() $(declare -f usb_state_write_real | sed 1d)"
  # R14 rung d, no log line: unchanged (one escalated page, no would_do, no hold read needed)
  usb_reset; : >"$T/log.txt"; usb_go "$U_TRUE"
  usb_esc "rung d"; assert_not "$(events)" 'WOULD-DO' "rung d: no would_do"; assert_eq "$(n_reboot_calls)" "0" "rung d: no reboot"
}

test_usb_s1_pending_verify_never_recurring_and_root_rc_fail() {
  load_libs; usb_reset
  # pending verify (a fresh agent after the boot, device still gone): no recurring page
  printf 'date=%s\nepoch=%s\nrecorder_pid=1\ncoreaudiod_pid=1\nboot_age_s=1\nport=x\nverify=pending\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW + 5))" >"$STATE_DIR/usb-reboot"
  usb_go "$U_CLEAR"
  assert_not "$(events)" 'usb_power_off_recurring' "R2: no recurring while verify=pending"
  usb_esc "C: verify_pending"; assert_has "$(events)" 'verify_pending' "C: reason verify_pending"
  assert_eq "$(n_reboot_calls)" "0" "R2: no second reboot"
  # the root verb fails (old helper): usb_reboot_failed, never recurring, budget spent, no retry
  usb_reset; printf '#!/bin/bash\necho "ROOTFAIL $*" >>"$CALLS"\nexit 3\n' >"$T/bin/failhelper"; chmod +x "$T/bin/failhelper"
  local keep="$GUARDIAN_ROOT_HELPER"; export GUARDIAN_ROOT_HELPER="$T/bin/failhelper"
  usb_go "$U_CLEAR"
  assert_has "$(events | grep '"reason":"usb_reboot_failed"')" '"result":"escalated"' "R4: usb_reboot_failed escalated"
  assert_has "$(events)" '"result":"reboot_failed"' "R4: reboot_failed event"
  assert_not "$(events)" 'usb_power_off_recurring' "R4: not recurring"
  assert_eq "$(usb_budget_state)" "today" "R4: the budget stays spent"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^verify=pending$' "R4: verify stays pending"
  : >"$CALLS"; : >"$T/pub.log"; rm -f "$STATE_DIR/usb_absent" "$STATE_DIR/cc_probe.neg"
  usb_go "$U_CLEAR"
  assert_eq "$(grep -c ROOTFAIL "$CALLS")" "0" "R4: no retry the next tick"
  assert_not "$(events)" 'usb_power_off_recurring' "R4: still not recurring"
  export GUARDIAN_ROOT_HELPER="$keep"
}

test_usb_s2_heal_extra_from_environment_never_reaches_an_event() {
  export HEAL_EXTRA=',"evil":1'
  load_libs
  escalate probe_kind usb "x"; heal_event info usb x y "" noted false
  assert_not "$(events)" 'evil' "S2: heal.sh load clears an inherited HEAL_EXTRA"
  unset HEAL_EXTRA
  assert_has "$(grep -n 'GUARDIAN_PIPE_SSH' "$KDIR/bin/guardian.sh")" 'HEAL_EXTRA' "S2: HEAL_EXTRA is in the run-mode unset list"
}

test_usb_s3_device_back_after_the_second_read_aborts() {
  load_libs; usb_reset
  eval "act_step_real() $(declare -f act_step | sed 1d)"
  act_step() { act_step_real; local r=$?; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; return $r; }
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "R5: device replugged after the collector read: no reboot"
  assert_has "$(events)" 'aborted_device_back' "R5: reported"
  usb_esc "R5"
  assert_eq "$(usb_budget_state)" "none" "R5: the budget is not spent"
  # the re-read itself failing is an abort too
  usb_reset
  act_step() { act_step_real; local r=$?; printf '#!/bin/bash\nexit 1\n' >"$T/bin/ioreg"; return $r; }
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "R5: a failed re-read: no reboot"
  usb_esc "R5 failed re-read"
  eval "act_step() $(declare -f act_step_real | sed 1d)"
}

test_usb_s4_future_dated_state_is_bad() {
  load_libs
  local c
  for c in date epoch; do
    usb_reset
    if [ "$c" = date ]; then printf 'date=%s\nepoch=1\nverify=healed_pending\n' "$(TZ=Asia/Kolkata date -r "$((GUARDIAN_FAKE_NOW + 86400))" +%Y%m%d)" >"$STATE_DIR/usb-reboot"
    else printf 'date=%s\nepoch=%s\nverify=healed_pending\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW + 400))" >"$STATE_DIR/usb-reboot"; fi
    assert_eq "$(usb_budget_state)" "bad" "R7: future $c is bad"
    usb_go "$U_CLEAR"
    assert_eq "$(n_reboot_calls)" "0" "R7: future $c: no reboot"
    usb_esc "R7 $c"
  done
  usb_reset; printf 'date=%s\nepoch=%s\nverify=healed_pending\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW + 200))" >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "today" "an epoch within 300 s ahead is tolerated"
  usb_reset; printf 'date=00000000\nverify=void\n' >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "none" "the void marker is none"
}

test_usb_s5_ist_date_failure_means_no_reboot() {
  load_libs; usb_reset
  eval "ist_date_real() $(declare -f ist_date | sed 1d)"
  ist_date() { echo ""; }
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "R6: ist_date empty: no reboot"
  usb_esc "R6"
  usb_reset; ist_date() { echo "2026-10-14"; }
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "R6: ist_date not 8 digits: no reboot"
  eval "ist_date() $(declare -f ist_date_real | sed 1d)"
}

test_usb_s6_planted_symlinks_are_never_followed() {
  load_libs; usb_reset
  printf 'precious\n' >"$T/outside"; ln -s "$T/outside" "$STATE_DIR/usb-reboot.tmp"
  usb_go "$U_CLEAR"
  assert_eq "$(cat "$T/outside")" "precious" "R10: the planted tmp symlink target is untouched"
  assert_eq "$(n_reboot_calls)" "0" "R10: no reboot"
  usb_esc "R10"
  rm -f "$STATE_DIR/usb-reboot.tmp"
  # a symlinked state path
  usb_reset; ln -s "$T/outside" "$STATE_DIR/usb-reboot"
  usb_go "$U_CLEAR"
  assert_eq "$(cat "$T/outside")" "precious" "R10: the symlinked state target is untouched"
  assert_eq "$(n_reboot_calls)" "0" "R10: symlinked state: no reboot"
  rm -f "$STATE_DIR/usb-reboot"
  # the tmp file comes from mktemp in the state dir
  assert_has "$(grep -n 'G_MKTEMP' "$KDIR/lib/heal.sh")" 'usb-reboot.XXXXXX' "S6: mktemp in the state dir"
  # a good run leaves a regular file and the reboot goes
  usb_reset; usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "1" "a clean run still reboots"
  [ -f "$STATE_DIR/usb-reboot" ] && [ ! -L "$STATE_DIR/usb-reboot" ] && ok || fail "state is a regular file"
}

test_usb_s7_root_helper_never_resolves_id_through_path() {
  local h="$KDIR/bin/guardian-root.sh"
  assert_eq "$(grep -v '^[[:space:]]*#' "$h" | grep -c 'id -u')" "0" "S7: no id -u in the helper"
  assert_eq "$(grep -c 'EUID. -ne 0' "$h")" "2" "S7: both test seams test \$EUID"
}

test_usb_s8_ist_date_ignores_the_local_zone() {
  load_libs
  local e1 e2 z
  e1="$(ist_epoch 00:30)"; e2="$(ist_epoch 23:50)"
  for z in America/Los_Angeles UTC Asia/Kolkata Pacific/Kiritimati; do
    assert_eq "$(TZ=$z ist_date "$e1")" "20261014" "S8: 00:30 IST under TZ=$z"
    assert_eq "$(TZ=$z ist_date "$e2")" "20261014" "S8: 23:50 IST under TZ=$z"
  done
}

test_usb_tick_span_needs_20s_as_well_as_two_ticks() {
  load_libs; usb_reset
  usb_ctl "$U_CLEAR"; collect_all
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_eq "$S_usb_ticks" "2" "two ticks 10 s apart"
  assert_has "$(fault_tree)" 'usb_device_missing' "10 s span: still rung d"
  assert_not "$(fault_tree)" 'usb_power_off' "10 s span: not d'"
  heal_cycle >/dev/null 2>&1
  assert_eq "$(n_reboot_calls)" "0" "10 s span: no reboot"
  assert_not "$(cat "$CALLS")" '^LOG ' "10 s span: the log is not read"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW; usb_ctl "$U_CLEAR"; collect_all
  assert_has "$(fault_tree)" 'usb_power_off' "20 s span: d'"
}

test_usb_no_kind_key_on_any_usb_heal_line() {
  load_libs; usb_reset
  usb_go "$U_CLEAR"
  usb_state_set_verify healed_pending
  assert_not "$(events)" '"kind"' "no kind key on the reboot lines"
  assert_has "$(events)" '"action":"kiosk_reboot","layer":"usb"' "d1 names kept: action kiosk_reboot, layer usb"
}

test_usb_a_dprime_is_shadow_in_the_shipped_build() {
  export GUARDIAN_TEST_DPRIME_HEAL=0
  load_libs; usb_reset
  assert_eq "$USB_DPRIME_HEAL" "0" "constant is 0"
  usb_go "$U_CLEAR"   # mode heal, fresh new-form false, every guard true
  assert_eq "$(n_reboot_calls)" "0" "A: HEAL + clear + all guards: 0 reboot calls"
  assert_eq "$(n_shutdown)" "0" "A: no shutdown"
  assert_has "$(events)" 'WOULD-DO blocked=dprime_shadow' "A: would_do blocked=dprime_shadow"
  assert_has "$(events)" '"shadow":true' "A: report-only"
  assert_has "$(events | grep 'dprime_shadow')" '"reason":"usb_device_missing"' "A: usb_device_missing escalated with the reason (M1)"
  usb_esc "A"
  [ ! -s "$STATE_DIR/actions" ] && [ ! -e "$STATE_DIR/usb-reboot" ] && ok || fail "A: no action counted, no budget spent"
  # run mode: the flip is ignored and the constant is readonly
  local c="$KDIR/lib/common.sh"
  assert_eq "$(env -i HOME="$HOME" G_RUNMODE=1 GUARDIAN_TEST_DPRIME_HEAL=1 /bin/bash -c '. "$0"; echo "$USB_DPRIME_HEAL"' "$c" 2>/dev/null)" "0" "A: run mode ignores GUARDIAN_TEST_DPRIME_HEAL"
  assert_has "$(env -i HOME="$HOME" G_RUNMODE=1 /bin/bash -c '. "$0"; declare -p USB_DPRIME_HEAL' "$c" 2>/dev/null)" 'declare -r' "A: readonly in run mode"
  assert_has "$(sed -n '/unset GUARDIAN_TESTMODE/,/G_RUNMODE=1/p' "$KDIR/bin/guardian.sh")" 'GUARDIAN_TEST_DPRIME_HEAL' "A: guardian.sh unsets the seam in run mode"
  assert_eq "$(grep -c 'USB_DPRIME_HEAL' "$KDIR/lib/conf.sh")" "0" "A: not a conf key"
}

test_usb_b_budget_is_spent_for_24h_and_for_future_epochs() {
  load_libs; usb_reset
  local yday; yday="$(TZ=Asia/Kolkata date -r "$((GUARDIAN_FAKE_NOW - 86400))" +%Y%m%d)"
  printf 'date=%s\nepoch=%s\nverify=healed_pending\n' "$yday" "$((GUARDIAN_FAKE_NOW - 3600))" >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "today" "B: yesterday's date but 1 h ago: spent"
  printf 'date=%s\nepoch=%s\nverify=healed_pending\n' "$yday" "$((GUARDIAN_FAKE_NOW - 86401))" >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "none" "B: 24 h and 1 s ago on an earlier date: free"
  printf 'date=%s\nepoch=%s\nverify=healed_pending\n' "$yday" "$((GUARDIAN_FAKE_NOW + 100))" >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "today" "B: epoch later than now: spent"
  printf 'date=%s\nepoch=%s\nverify=healed_pending\n' "$yday" "$((GUARDIAN_FAKE_NOW - 3600))" >"$STATE_DIR/usb-reboot"
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "0" "B: no reboot inside 24 h of the last one"
  assert_has "$(events)" 'usb_power_off_recurring' "B: recurring page"
}

test_usb_d_log_line_must_be_from_the_kernel() {
  load_libs
  local c
  for c in nonkernel_pid other_proc; do
    usb_reset
    local when; when="$(date -r "$((GUARDIAN_FAKE_NOW - 120))" '+%Y-%m-%d %H:%M:%S')"
    case "$c" in
      nonkernel_pid) printf 'hdr\n%s.104 Df  kernel[501:4242] [com.apple.usb:all] usb-drd3-port-hs@03100000: AppleUSBHostPort::cableChangeOccurred: powering off\n' "$when" >"$T/log.txt" ;;
      other_proc) printf 'hdr\n%s.104 Df  evil[0:1] [com.apple.usb:all] usb-drd3-port-hs@03100000: AppleUSBHostPort::cableChangeOccurred: powering off\n' "$when" >"$T/log.txt" ;;
    esac
    usb_go "$U_CLEAR"
    assert_not "$(fault_tree)" 'usb_power_off' "D $c: no trigger"
    assert_eq "$(n_reboot_calls)" "0" "D $c: no reboot"
  done
}

# ---- R15 (d2 refute SHOULDs S-1, S-2 and notes N1) ----
# S-1: an epoch with a leading zero (octal to bash arithmetic) or one that fails arithmetic is "bad"; only exactly "none" may reach the reboot.
test_usb_r15_s1_leading_zero_epoch_is_bad_and_only_none_reboots() {
  load_libs
  local c ep
  for c in lz1 lz2 long; do
    usb_reset
    case "$c" in
      lz1) ep="0$((GUARDIAN_FAKE_NOW - 600))" ;;
      lz2) ep="0000000001" ;;
      long) ep="99999999999999999999" ;;
    esac
    printf 'date=00000000\nepoch=%s\nverify=healed_pending\n' "$ep" >"$STATE_DIR/usb-reboot"
    assert_eq "$(usb_budget_state)" "bad" "S-1 $c: the state is bad"
    usb_go "$U_CLEAR"
    assert_eq "$(n_reboot_calls)" "0" "S-1 $c: no reboot"
    usb_esc "S-1 $c"
  done
  # an epoch that is plain digits and old enough is still none (the positive control: the same fixture without the zero reboots)
  usb_reset; printf 'date=00000000\nepoch=%s\nverify=healed_pending\n' "$((GUARDIAN_FAKE_NOW - 2 * 86400))" >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "none" "S-1 control: an old plain epoch is none"
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "1" "S-1 control: none reboots"
  # any answer other than exactly none (an empty or unknown one, as a failed arithmetic read gives) is no reboot, and still escalates the rung d page
  for c in empty unknown; do
    usb_reset
    eval "usb_budget_state_real() $(declare -f usb_budget_state | sed 1d)"
    if [ "$c" = empty ]; then usb_budget_state() { echo ""; }; else usb_budget_state() { echo "weird"; }; fi
    usb_go "$U_CLEAR"
    assert_eq "$(n_reboot_calls)" "0" "S-1 $c answer: no reboot"
    usb_esc "S-1 $c answer"
    eval "usb_budget_state() $(declare -f usb_budget_state_real | sed 1d)"
  done
  # the verify path never reads a leading-zero epoch as octal: it leaves the state pending and publishes nothing
  usb_reset; printf 'date=%s\nepoch=0%s\nverify=pending\nport=p\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW - 700))" >"$STATE_DIR/usb-reboot"
  : >"$T/pub.log"; usb_reboot_verify
  assert_eq "$(events | wc -l | tr -d ' ')" "0" "S-1: verify with a leading-zero epoch publishes nothing"
  [ ! -e "$USB_LOCK" ] && ok || fail "S-1: and writes no lock"
}

# R15b N1: the state file exists, so an empty or non-digit epoch is "bad" (a planted or damaged file): 0 reboots with the seam on. The date is old (so a missing epoch used to fall through to "none").
test_usb_r15b_n1_empty_or_non_digit_epoch_is_bad_and_never_reboots() {
  load_libs
  local ep n=0
  for ep in abc "" 12x " 5" +5 1e9; do
    n=$((n + 1)); usb_reset
    printf 'date=00000000\nepoch=%s\nverify=healed_pending\n' "$ep" >"$STATE_DIR/usb-reboot"
    assert_eq "$(usb_budget_state)" "bad" "N1 [$ep]: the state is bad"
    usb_go "$U_CLEAR"
    assert_eq "$(n_reboot_calls)" "0" "N1 [$ep]: no reboot"
    usb_esc "N1 [$ep]"
  done
  # no epoch line at all (and not the void marker) is the same
  usb_reset; printf 'date=00000000\nverify=healed_pending\n' >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "bad" "N1: no epoch line is bad"
  usb_go "$U_CLEAR"; assert_eq "$(n_reboot_calls)" "0" "N1: no epoch line: no reboot"
  # the void marker the code itself writes (no epoch line at all) is none; the same with an empty epoch line is bad
  usb_reset; printf 'date=00000000\nverify=void\n' >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "none" "N1: the void marker (no epoch line) is none"
  usb_reset; printf 'date=00000000\nepoch=\nverify=void\n' >"$STATE_DIR/usb-reboot"
  assert_eq "$(usb_budget_state)" "bad" "N1: verify=void with an empty epoch line is bad"
  # positive control: the same fixture with a plain old epoch reboots
  usb_reset; printf 'date=00000000\nepoch=%s\nverify=healed_pending\n' "$((GUARDIAN_FAKE_NOW - 2 * 86400))" >"$STATE_DIR/usb-reboot"
  usb_go "$U_CLEAR"; assert_eq "$(n_reboot_calls)" "1" "N1 control: a plain old epoch reboots"
}

# a fake ioreg whose USB read can be slowed (T/slow) and whose reads advance a skew file read by now_epoch (T/bump): the two S-2 probes
usb_r15_ioreg() {
  cat >"$T/bin/ioreg" <<'F'
#!/bin/bash
case "$*" in
  *IOUSBHostDevice*) [ -e "$T/slow" ] && sleep 4
                     if [ -e "$T/bump" ]; then echo $(( $(cat "$T/skew" 2>/dev/null || echo 0) + 2 )) >"$T/skew"; fi
                     cat "$T/usb.txt" ;;
  *IOAudioEngine*) cat "$T/engine.txt" ;;
  *IOHIDSystem*) echo "    | |   \"HIDIdleTime\" = $(cat "$T/hid")" ;;
esac
F
  chmod +x "$T/bin/ioreg"
}
# usb_go with a hook between the second collect and the heal cycle
usb_go_pre() { # <payload> <hook command>
  usb_ctl "$1"; collect_all
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW
  usb_ctl "$1"; collect_all
  eval "$2"
  heal_cycle >/dev/null 2>&1
}

# S-2: the device re-read after the second kill read runs under run_capped 1 (a timeout aborts as device_back), and more than 1 s from that kill read to the root call aborts.
test_usb_r15_s2_slow_reread_and_slow_to_root_abort() {
  load_libs; usb_reset; usb_r15_ioreg
  local t0 t1
  # control: a fast re-read still reboots exactly once
  usb_go_pre "$U_CLEAR" ':'
  assert_eq "$(n_reboot_calls)" "1" "S-2 control: a fast re-read reboots once"
  # a 4 s ioreg: capped at 1 s, 0 reboots, aborted as device_back, the page kept, the state put back
  usb_reset; usb_r15_ioreg
  t0="$(date +%s)"
  usb_go_pre "$U_CLEAR" ': >"$T/slow"'
  t1="$(date +%s)"
  assert_eq "$(n_reboot_calls)" "0" "S-2: a slow re-read: 0 reboots"
  assert_has "$(events)" 'aborted_device_back' "S-2: aborted as device_back"
  usb_esc "S-2 slow re-read"
  [ "$((t1 - t0))" -lt 4 ] && ok || fail "S-2: the heal cycle did not wait out the 4 s read ($((t1 - t0)) s)"
  assert_eq "$(usb_budget_state)" "none" "S-2: the budget is not spent"
  rm -f "$T/slow"
  # the act_step epoch: a re-read that takes 2 s of (fake) clock between the second kill read and the root call aborts and escalates
  usb_reset; usb_r15_ioreg
  eval "now_epoch() { echo \$((GUARDIAN_FAKE_NOW + \$(cat \"$T/skew\" 2>/dev/null || echo 0))); }"
  rm -f "$T/skew"
  usb_go_pre "$U_CLEAR" ': >"$T/bump"'
  assert_eq "$(n_reboot_calls)" "0" "S-2: more than 1 s from the kill read to the root call: 0 reboots"
  assert_has "$(events | grep '"action":"abort"')" '"result":"aborted_before_reboot"' "S-2: aborted with the existing heal-line result name (no new one)"
  usb_esc "S-2 slow to root"
  assert_eq "$(usb_budget_state)" "none" "S-2: the state was put back"
}

# N1: a planted leftover usb-reboot.tmp makes the state rewrite fail every tick. One healed_pending per reboot epoch, and a lock written once whose epoch never moves.
test_usb_r15_n1_planted_tmp_dedupes_healed_pending_and_the_lock_epoch_is_stable() {
  load_libs; usb_reset
  local i n le1 le2
  usb_go "$U_CLEAR"
  assert_eq "$(n_reboot_calls)" "1" "reboot issued"
  # the kiosk comes back; a planted usb-reboot.tmp stops the state from moving on to healed_pending
  : >"$CALLS"; : >"$T/pub.log"; USB_REBOOT_ISSUED=0
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 120)); export GUARDIAN_FAKE_NOW; export FAKE_BOOT_AGE=40
  printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; echo 7777 >"$T/rec_pid"; echo 5001 >"$T/tapewriters"
  : >"$STATE_DIR/usb-reboot.tmp"
  for i in 1 2 3 4 5 6; do
    usb_ctl "$U_CLEAR"; collect_all; heal_cycle >/dev/null 2>&1
    GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW
  done
  n="$(events | grep -c '"result":"healed_pending"')"
  [ "$n" -le 1 ] && [ "$n" -ge 1 ] && ok || fail "N1: exactly one healed_pending in 6 ticks (got $n)"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^verify=pending$' "N1: the state really could not move on (the planted file is in the way)"
  # the failed branch: the device never comes back, 10+ min pass, the planted file is still there
  rm -f "$STATE_DIR/usb-reboot.tmp"; usb_reset; unset FAKE_BOOT_AGE
  usb_go "$U_CLEAR"
  : >"$CALLS"; : >"$T/pub.log"; USB_REBOOT_ISSUED=0; : >"$STATE_DIR/usb-reboot.tmp"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 700)); export GUARDIAN_FAKE_NOW
  usb_ctl "$U_CLEAR"; collect_all; heal_cycle >/dev/null 2>&1
  le1="$(sed -n 1p "$USB_LOCK")"
  [ -n "$le1" ] && ok || fail "N1: the lock was written"
  for i in 1 2 3 4 5 6; do
    GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 10)); export GUARDIAN_FAKE_NOW
    usb_ctl "$U_CLEAR"; collect_all; heal_cycle >/dev/null 2>&1
  done
  le2="$(sed -n 1p "$USB_LOCK")"
  assert_eq "$le2" "$le1" "N1: the lock epoch did not move in 6 more ticks"
  assert_eq "$(grep -c 'verify failed: rung locked' "$GUARDIAN_HOME/audit.log")" "1" "N1: the lock is audited once"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^verify=pending$' "N1: the planted file kept the state pending"
  # a later reboot's failure still gets its own lock (the lock is per reboot epoch, not once for ever)
  rm -f "$STATE_DIR/usb-reboot.tmp"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 800)); export GUARDIAN_FAKE_NOW
  printf 'date=%s\nepoch=%s\nverify=pending\nport=p\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW - 700))" >"$STATE_DIR/usb-reboot"
  usb_ctl "$U_CLEAR"; collect_all; heal_cycle >/dev/null 2>&1
  [ "$(sed -n 1p "$USB_LOCK")" -gt "$le1" ] && ok || fail "N1: a failure of a later reboot refreshed the lock"
}
