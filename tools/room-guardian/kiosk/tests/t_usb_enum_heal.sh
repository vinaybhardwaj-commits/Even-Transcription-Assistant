#!/bin/bash
# USB enumeration-failure self-heal ladder: rung A coreaudiod, rung B enum-failure reboot, rung C device unplugged (lib/heal.sh usb_enum_ladder).
# Fakes only (lib.sh): /sbin/shutdown, /usr/bin/log, fdesetup, ioreg, defaults and the clock. Nothing here reboots anything.
# Each table case runs in a subshell (the constants are readonly once the libs load) and prints one summary line the parent asserts on.
# shellcheck disable=SC2034,SC2154

# ue_setup: knobs CONST (USB_ENUM_HEAL, default 1) ALLOW (SENTINEL_HEAL_CODES; unset = the default) MODE heal|shadow|kill EVID log|ioreg|none HID (s) CAP (capture_open)
# AUTOL 1|0 FDE off|on|unknown|none RETURNS 1 (rung A brings the device back)
ue_setup() {
  export GUARDIAN_TEST_USB_ENUM_HEAL="${CONST:-1}"
  if [ -n "${ALLOW+x}" ]; then export GUARDIAN_TEST_SENTINEL_HEAL_CODES="$ALLOW"; fi
  load_libs
  # rung A: the second gsleep inside heal_coreaudiod's wait sees a new coreaudiod pid; the 15 s recheck brings the device back when RETURNS=1
  gsleep() {
    case "$1" in
      15) if [ "${RETURNS:-0}" = 1 ]; then printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; fi ;;
      *) echo "$((10000 + RANDOM))" >"$T/ca_pid" ;;
    esac
    return 0
  }
  rm -rf "$STATE_DIR"; mkdir -p "$STATE_DIR" "$FLAG_DIR"   # every table case starts from clean state
  : >"$CALLS"; : >"$T/pub.log"; USB_REBOOT_ISSUED=0
  GUARDIAN_FAKE_NOW="$(ist_epoch 11:00)"; export GUARDIAN_FAKE_NOW
  : >"$T/engine.txt"; echo "$(( ${HID:-1000} * 1000000000 ))" >"$T/hid"
  case "${EVID:-log}" in
    log) : >"$T/usb.txt"; printf '%s.104 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost\n' "$(date -r "$GUARDIAN_FAKE_NOW" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$GUARDIAN_FAKE_NOW" '+%Y-%m-%d %H:%M:%S')" >"$T/log.txt" ;;
    ioreg) printf '+-o Unknown Device@01100000  <class IOUSBHostDevice, id 0x1, registered>\n' >"$T/usb.txt"; : >"$T/log.txt" ;;
    none) : >"$T/usb.txt"; : >"$T/log.txt" ;;
    hub) printf '+-o USB2 Hub@01100000  <class IOUSBHostDevice, id 0x1, registered>\n  | +-o AppleUSBHubInterface  <class IOUSBHostInterface, id 0x2>\n+-o USB3 Gen2 Hub@02100000  <class IOUSBHostDevice, id 0x3, registered>\n  | +-o AppleUSBHubInterface  <class IOUSBHostInterface, id 0x4>\n' >"$T/usb.txt"; : >"$T/log.txt" ;;
    hubok) printf '+-o USB2 Hub@01100000  <class IOUSBHostDevice, id 0x1, registered>\n  | +-o AppleUSBHubInterface  <class IOUSBHostInterface, id 0x2>\n  | +-o Keyboard Dongle@1  <class IOUSBHostDevice, id 0x5, registered>\n  |   +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x6>\n' >"$T/usb.txt"; : >"$T/log.txt" ;;
  esac
  [ "${AUTOL:-1}" = 1 ] && printf '#!/bin/bash\necho kioskuser\n' >"$T/bin/defaults" || printf '#!/bin/bash\nexit 1\n' >"$T/bin/defaults"
  case "${FDE:-off}" in
    off) printf '#!/bin/bash\necho "FileVault is Off."\n' >"$T/bin/fakefde" ;;
    on) printf '#!/bin/bash\necho "FileVault is On."\n' >"$T/bin/fakefde" ;;
    unknown) printf '#!/bin/bash\nexit 1\n' >"$T/bin/fakefde" ;;
  esac
  [ "${PRESENT:-0}" = 1 ] && printf 'USB Audio C270 HD\n' >"$T/usb.txt"   # on the bus but no CoreAudio input
  chmod +x "$T/bin/defaults" "$T/bin/fakefde"
  export GUARDIAN_FDESETUP_BIN="$T/bin/fakefde"
  command -v sqlite3 >/dev/null 2>&1 && mk_tcc 2
  write_status capture_open="${CAP:-false}"
  ue_mode "${MODE:-heal}"
}
ue_mode() {
  case "$1" in
    heal) printf 'fleet=on\nmode=heal\n' >"$T/flagout" ;;
    shadow) printf 'fleet=on\nmode=shadow\n' >"$T/flagout" ;;
    kill) printf 'fleet=off\nmode=heal\n' >"$T/flagout" ;;
  esac
  echo 0 >"$T/flagrc"; rm -f "$STATE_DIR/flags.cache" "$STATE_DIR/flag_last"; flag_fetch
}
# one health tick pair (ticks >= 2 and span >= 20 s) then the heal cycle
ue_tick() {
  write_status capture_open="${CAP:-false}"
  rm -f "$STATE_DIR/flags.cache"; flag_fetch; collect_all
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW
  write_status capture_open="${CAP:-false}"
  rm -f "$STATE_DIR/flags.cache"; flag_fetch; collect_all
  heal_cycle >/dev/null 2>&1
}
ue_reboots() { grep -c 'guardian-root.sh reboot$' "$CALLS"; }
ue_summary() { echo "reboots=$(ue_reboots) shutdowns=$(grep -c '^SHUTDOWN ' "$CALLS") A=$(grep -c 'coreaudiod-kill' "$CALLS") $(events | grep -o 'blocked=[a-z_0-9]*\|room_device_unplugged\|reboot_pending\|healed' | tr '\n' ' ')"; }
# ue_case <knob=value ...>: one fresh scenario, one tick, the summary line
ue_case() {
  ( for kv in "$@"; do export "${kv?}"; done; ue_setup; ue_tick; ue_summary )
}
# an already-ran rung A, so a case can probe rung B guards one at a time
ue_case_a() {
  ( for kv in "$@"; do export "${kv?}"; done; ue_setup; ue_tick; : >"$CALLS"; : >"$T/pub.log"; rm -rf "$STATE_DIR/once"; ue_tick; ue_summary )
}

test_ue_all_guards_true_one_reboot_after_rung_a() {
  local s; s="$(ue_case CONST=1)"
  assert_has "$s" 'reboots=1 shutdowns=1 A=1' "rung A ran, then exactly one reboot"
  assert_has "$s" 'reboot_pending' "reboot event written"
}

test_ue_reboot_writes_audit_and_event_before_the_shutdown_and_uses_the_d_prime_state() {
  ue_setup
  ue_tick
  assert_eq "$(ue_reboots)" "1" "one reboot"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" 'usb-enum-reboot: issuing reboot kind=absent evidence=log session_was_open=' "audit line"
  assert_has "$(events)" '"action":"kiosk_reboot","layer":"usb","reason":"usb_enum_reboot"' "heal event"
  assert_has "$(cat "$STATE_DIR/usb-reboot")" '^verify=pending$' "the shared usb-reboot state, verify pending (the d' verify/lock path owns the aftermath)"
  assert_has "$(cat "$CALLS")" 'SHUTDOWN_STATE_WRITTEN=yes' "state written before the shutdown ran"
  assert_has "$(cat "$STATE_DIR/usb-enum-reboot")" ' pending$' "2 h stamp written"
  assert_eq "$(grep -c 'guardian-root.sh' "$CALLS")" "$(grep -c 'guardian-root.sh \(reboot\|coreaudiod-kill\|fde-status\|tcc-row .*\)$' "$CALLS")" "only whitelisted verbs"
}

test_ue_each_guard_false_gives_no_reboot_with_exact_reason() {
  assert_has "$(ue_case EVID=none)" 'reboots=0 .*room_device_unplugged' "no evidence + absent = rung C, not a reboot"
  assert_has "$(ue_case_a CAP=true)" 'reboots=0 .*blocked=capture_open' "capture open"
  assert_has "$(ue_case_a HID=300)" 'reboots=0 .*blocked=hid_busy' "HID idle exactly 300 s is not over 300"
  assert_has "$(ue_case_a HID=20)" 'reboots=0 .*blocked=hid_busy' "HID busy"
  assert_has "$(ue_case_a AUTOL=0)" 'reboots=0 .*blocked=no_autologin' "no autoLoginUser"
  assert_has "$(ue_case_a FDE=on)" 'reboots=0 .*blocked=filevault_on' "FileVault on"
  assert_has "$(ue_case_a FDE=unknown)" 'reboots=0 .*blocked=filevault_unknown' "FileVault unknown is off-limits"
  assert_has "$(ue_case EVID=ioreg)" 'reboots=1' "evidence by ioreg alone (a device node without interfaces) is enough"
}

test_ue_static_gates_would_do_only() {
  assert_has "$(ue_case MODE=shadow)" 'reboots=0 shutdowns=0 A=0 blocked=mode_not_heal' "shadow mode: would_do only, not even rung A"
  assert_has "$(ue_case MODE=kill)" 'reboots=0 shutdowns=0 A=0 blocked=killswitch' "kill engaged"
  assert_has "$(ue_case ALLOW=other_code)" 'reboots=0 shutdowns=0 A=0 blocked=code_not_allowlisted' "code not in SENTINEL_HEAL_CODES"
  assert_has "$(ue_case ALLOW=)" 'reboots=0 shutdowns=0 A=0 blocked=code_not_allowlisted' "empty allowlist"
  assert_has "$(ue_case CONST=0)" 'reboots=0 shutdowns=0 A=0 blocked=usb_enum_heal_off' "constant 0 (the shipped default): inert"
}

test_ue_default_is_off_without_any_seam() {
  unset GUARDIAN_TEST_USB_ENUM_HEAL
  load_libs
  assert_eq "$USB_ENUM_HEAL" "0" "USB_ENUM_HEAL defaults to 0"
  assert_eq "$(grep -c 'g_const USB_ENUM_HEAL 0' "$KDIR/lib/common.sh")" "1" "run mode assigns 0 unconditionally"
}

test_ue_rung_a_success_means_no_rung_b_and_session_was_open_reported() {
  ( ue_setup; printf 'true\n' >"$STATE_DIR/usb-enum-session"; export RETURNS=1
    ue_tick
    ue_summary
    : >"$T/pub.log"; collect_all; heal_cycle >/dev/null 2>&1
    echo "after: $(events | grep -o 'usb_enum_coreaudiod\|session_was_open=[a-z]*' | tr '\n' ' ') reboots=$(ue_reboots)" ) >"$T/out"
  assert_has "$(cat "$T/out")" 'reboots=0 shutdowns=0 A=1' "rung A killed coreaudiod and the device came back: no reboot"
  assert_has "$(cat "$T/out")" 'after: usb_enum_coreaudiod session_was_open=true *reboots=0' "heal line carries session_was_open"
}

test_ue_reboot_fires_once_and_a_second_fault_inside_2h_does_not() {
  ue_setup
  ue_tick
  assert_eq "$(ue_reboots)" "1" "first fault: one reboot"
  # the machine came back healthy and the d' verify proved it
  usb_state_set_verify healed_pending
  USB_REBOOT_ISSUED=0
  printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 600)); export GUARDIAN_FAKE_NOW; write_status capture_open=false
  collect_all; heal_cycle >/dev/null 2>&1
  assert_has "$(events)" 'usb_enum_reboot.*healed' "post-boot healed report"
  # a second fault one hour later
  : >"$T/usb.txt"; : >"$T/engine.txt"; : >"$CALLS"; : >"$T/pub.log"; rm -rf "$STATE_DIR/once"; rm -f "$STATE_DIR/usb_absent" "$STATE_DIR/usb_enum_log.out"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 3400)); export GUARDIAN_FAKE_NOW
  ue_tick; ue_tick
  assert_eq "$(ue_reboots)" "0" "inside 2 h: no reboot"
  assert_has "$(events)" 'blocked=reboot_cap_2h' "exact reason"
  # past 2 h
  : >"$CALLS"; : >"$T/pub.log"; rm -rf "$STATE_DIR/once"; rm -f "$STATE_DIR/usb_absent"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 4000)); export GUARDIAN_FAKE_NOW
  usb_state_set_verify healed_pending
  ue_tick; ue_tick
  assert_eq "$(ue_reboots)" "1" "past 2 h: allowed again"
}

test_ue_failed_verify_locks_the_rung() {
  ue_setup
  ue_tick
  USB_REBOOT_ISSUED=0
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 800)); export GUARDIAN_FAKE_NOW; write_status capture_open=false
  : >"$CALLS"; : >"$T/pub.log"; rm -rf "$STATE_DIR/once"
  collect_all; heal_cycle >/dev/null 2>&1   # still absent 800 s after the reboot: the d' verify fails and locks
  assert_has "$(events)" 'usb_reboot_failed' "escalated once by the existing verify path"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 8000)); export GUARDIAN_FAKE_NOW
  : >"$CALLS"; rm -rf "$STATE_DIR/once"; rm -f "$STATE_DIR/usb_absent"
  ue_tick; ue_tick
  assert_eq "$(ue_reboots)" "0" "locked 24 h"
  assert_has "$(events)" 'blocked=rung_locked' "exact reason"
}

test_ue_capture_open_never_reboots_across_ticks() {
  CAP=true; export CAP; ue_setup
  ue_tick; ue_tick; ue_tick
  assert_eq "$(ue_reboots)" "0" "capture open: never"
  assert_eq "$(grep -c 'coreaudiod-kill' "$CALLS")" "0" "nor rung A (heal_coreaudiod itself refuses with a capture open)"
}

test_ue_rung_c_escalates_once_per_episode_and_rearms() {
  EVID=none; export EVID
  ue_setup
  local i
  for i in 1 2 3 4 5 6; do ue_tick; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 700)); export GUARDIAN_FAKE_NOW; done
  assert_eq "$(events | grep -c 'room_device_unplugged')" "1" "one escalation across many ticks and many hours of 10 min dedupe windows"
  assert_eq "$(ue_reboots)" "0" "no reboot for a device that is not on the bus"
  assert_eq "$(grep -c 'coreaudiod-kill' "$CALLS")" "0" "no coreaudiod kill either: no software fix"
  # the device returns, then goes again: a new episode
  printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"
  collect_all; heal_cycle >/dev/null 2>&1
  : >"$T/usb.txt"; : >"$T/engine.txt"; rm -f "$STATE_DIR/usb_absent"
  ue_tick
  assert_eq "$(events | grep -c 'room_device_unplugged')" "2" "re-armed after the device returned"
}

test_ue_rung_c_shadow_is_would_do() {
  EVID=none MODE=shadow; export EVID MODE
  ue_setup; ue_tick
  assert_has "$(events)" 'WOULD-DO blocked=mode_not_heal' "shadow"
  assert_not "$(events)" '"action":"escalate".*room_device_unplugged' "no escalate in shadow"
}

test_ue_session_was_open_recorded_in_the_reboot_event() {
  ue_setup
  printf 'true\n' >"$STATE_DIR/usb-enum-session"
  ue_tick
  assert_has "$(events)" 'reboot_pending session_was_open=true' "session_was_open:true"
  assert_eq "$(awk '{print $2}' "$STATE_DIR/usb-enum-reboot")" "true" "kept for the post-boot report"
}

test_ue_no_room_or_recorder_commands() {
  ue_setup; ue_tick
  assert_not "$(cat "$CALLS")" 'start_""day\|restart_engine\|^room-recorder\|^launchctl boot' "no room or recorder command from the kiosk"
}

test_ue_helper_fde_verb() {
  ue_setup
  assert_eq "$(root_do fde-status)" "off" "fde-status off"
  printf '#!/bin/bash\necho "FileVault is On."\n' >"$T/bin/fakefde"
  assert_eq "$(root_do fde-status)" "on" "fde-status on"
  printf '#!/bin/bash\necho garbage\n' >"$T/bin/fakefde"
  assert_eq "$(root_do fde-status)" "unknown" "anything else is unknown"
}

test_ue_no_input_with_the_device_on_the_bus_needs_evidence() {
  assert_has "$(ue_case PRESENT=1 EVID=none)" 'reboots=0 .*blocked=no_enum_evidence' "zero input engine, no enumeration evidence: no reboot"
  assert_not "$(ue_case PRESENT=1 EVID=none)" 'room_device_unplugged' "a device on the bus is never rung C"
  assert_has "$(ue_case PRESENT=1 EVID=log)" 'reboots=1' "zero input engine plus kernel-log evidence: reboot after rung A"
}

# ---- Amendment 1: rung C. Hub enumerated with nothing downstream = the same idle-gated reboot as rung B ----
test_ue_amend_empty_hub_reboots_once_with_every_rung_b_guard() {
  assert_has "$(ue_case EVID=hub)" 'reboots=1 shutdowns=1 A=1' "absent device + hub with empty downstream: rung A then one reboot"
  assert_not "$(ue_case EVID=hub)" 'room_device_unplugged' "no unplugged escalation before the reboot is tried"
  assert_has "$(ue_case_a EVID=hub CAP=true)" 'reboots=0 .*blocked=capture_open' "capture open still holds"
  assert_has "$(ue_case_a EVID=hub HID=20)" 'reboots=0 .*blocked=hid_busy' "HID still holds"
  assert_has "$(ue_case EVID=hub CONST=0)" 'reboots=0 .*blocked=usb_enum_heal_off' "constant still holds"
  assert_has "$(ue_case EVID=hub ALLOW=)" 'reboots=0 .*blocked=code_not_allowlisted' "allowlist still holds"
}

test_ue_amend_still_absent_after_reboot_escalates_once_and_no_second_reboot() {
  EVID=hub; export EVID
  ue_setup
  ue_tick
  assert_eq "$(ue_reboots)" "1" "the reboot"
  assert_eq "$(events | grep -c 'room_device_unplugged')" "0" "not escalated at reboot time"
  # after the reboot and the verify window the hub is still empty
  USB_REBOOT_ISSUED=0
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 800)); export GUARDIAN_FAKE_NOW
  : >"$CALLS"; rm -rf "$STATE_DIR/once"; rm -f "$STATE_DIR/usb_absent"
  ue_tick; ue_tick; ue_tick
  assert_eq "$(events | grep -c '"reason":"room_device_unplugged"')" "1" "one unplugged escalation"
  assert_eq "$(ue_reboots)" "0" "no second reboot inside 2 h"
}

test_ue_amend_absent_without_hub_evidence_escalates_unplugged_and_never_reboots() {
  assert_has "$(ue_case EVID=hubok)" 'reboots=0 shutdowns=0 A=0 .*room_device_unplugged' "hub with a child downstream is no evidence: unplugged, no reboot, no rung A"
  assert_has "$(ue_case EVID=none)" 'reboots=0 shutdowns=0 A=0 .*room_device_unplugged' "no hub at all: unplugged, no reboot"
}
