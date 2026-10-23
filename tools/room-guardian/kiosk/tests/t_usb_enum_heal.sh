#!/bin/bash
# USB enumeration-failure self-heal ladder: rung A coreaudiod, rung B enum-failure reboot, rung C device unplugged (lib/heal.sh usb_enum_ladder).
# Fakes only (lib.sh): /sbin/shutdown, /usr/bin/log, fdesetup, ioreg, defaults and the clock. Nothing here reboots anything.
# Each table case runs in a subshell (the constants are readonly once the libs load) and prints one summary line the parent asserts on.
# shellcheck disable=SC2034,SC2154,SC2030,SC2031

# date string like `log show --style compact` prints it (local time)
ue_ts() { date -r "$1" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$1" '+%Y-%m-%d %H:%M:%S'; }
# a fresh mic kernel line stamped at the fake clock
ue_log_now() { printf '%s.104 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost\n' "$(ue_ts "$GUARDIAN_FAKE_NOW")" >"$T/log.txt"; }
# IOUSB-plane fixtures. ALL SHAPES ARE INFERRED (no real kiosk capture yet; the deputy has asked for one, R3). Nodes: "+-o name@location  <class ...>", a child nests deeper.
ue_iousb() {
  case "$1" in
    hub_empty) printf '%s\n' '+-o Root  <class IORegistryEntry, id 0x100000100, retain 20>' \
      '  +-o USB2 Hub@01100000  <class IOUSBHostDevice, id 0x10, registered, matched, active>' \
      '  | +-o AppleUSBHubPort@1  <class AppleUSBHubPort, id 0x11>' \
      '  +-o USB3 Gen2 Hub@01200000  <class IOUSBHostDevice, id 0x12, registered, matched, active>' \
      '  | +-o AppleUSBHubPort@1  <class AppleUSBHubPort, id 0x13>' \
      '  +-o Keyboard Dongle@02100000  <class IOUSBHostDevice, id 0x20, registered, matched, active>' \
      '    +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x21>' >"$T/iousb.txt" ;;
    hub_dongle) printf '%s\n' '+-o Root  <class IORegistryEntry, id 0x100000100, retain 20>' \
      '  +-o USB2 Hub@01100000  <class IOUSBHostDevice, id 0x10, registered, matched, active>' \
      '  | +-o AppleUSBHubPort@1  <class AppleUSBHubPort, id 0x11>' \
      '  | | +-o Keyboard Dongle@01110000  <class IOUSBHostDevice, id 0x14, registered, matched, active>' \
      '  | |   +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x15>' \
      '  +-o USB3 Gen2 Hub@01200000  <class IOUSBHostDevice, id 0x12, registered, matched, active>' \
      '  | +-o AppleUSBHubPort@1  <class AppleUSBHubPort, id 0x13>' >"$T/iousb.txt" ;;
    hub_healthy) printf '%s\n' '+-o Root  <class IORegistryEntry, id 0x100000100, retain 20>' \
      '  +-o USB2 Hub@01100000  <class IOUSBHostDevice, id 0x10, registered, matched, active>' \
      '  | +-o AppleUSBHubPort@1  <class AppleUSBHubPort, id 0x11>' \
      '  | | +-o USB Audio C270 HD@01110000  <class IOUSBHostDevice, id 0x14, registered, matched, active>' \
      '  | |   +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x15>' \
      '  | +-o AppleUSBHubPort@2  <class AppleUSBHubPort, id 0x16>' \
      '  | | +-o Keyboard Dongle@01120000  <class IOUSBHostDevice, id 0x17, registered, matched, active>' \
      '  | |   +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x18>' \
      '  +-o USB3 Gen2 Hub@01200000  <class IOUSBHostDevice, id 0x12, registered, matched, active>' \
      '  | +-o AppleUSBHubPort@1  <class AppleUSBHubPort, id 0x13>' >"$T/iousb.txt" ;;
    # two physical hubs (INFERRED): prefix 01 healthy (USB2 half has a dongle), prefix 03 with BOTH halves empty
    hub_two) printf '%s\n' '+-o Root  <class IORegistryEntry, id 0x100000100, retain 20>' \
      '  +-o USB2 Hub@01100000  <class IOUSBHostDevice, id 0x10, registered, matched, active>' \
      '  | +-o AppleUSBHubPort@1  <class AppleUSBHubPort, id 0x11>' \
      '  | | +-o Keyboard Dongle@01110000  <class IOUSBHostDevice, id 0x14, registered, matched, active>' \
      '  +-o USB3 Gen2 Hub@01200000  <class IOUSBHostDevice, id 0x12, registered, matched, active>' \
      '  +-o USB2 Hub@03100000  <class IOUSBHostDevice, id 0x30, registered, matched, active>' \
      '  +-o USB3 Gen2 Hub@03200000  <class IOUSBHostDevice, id 0x32, registered, matched, active>' >"$T/iousb.txt" ;;
    nohub) printf '%s\n' '+-o Root  <class IORegistryEntry, id 0x100000100, retain 20>' \
      '  +-o Keyboard Dongle@02100000  <class IOUSBHostDevice, id 0x20, registered, matched, active>' >"$T/iousb.txt" ;;
    usb2_half_only) printf '%s\n' '+-o Root  <class IORegistryEntry, id 0x100000100, retain 20>' \
      '  +-o USB2 Hub@01100000  <class IOUSBHostDevice, id 0x10, registered, matched, active>' >"$T/iousb.txt" ;;
  esac
}

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
  : >"$T/iousb.txt"
  case "${EVID:-log}" in
    log) : >"$T/usb.txt"; printf '%s.104 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost\n' "$(ue_ts "$GUARDIAN_FAKE_NOW")" >"$T/log.txt" ;;
    # a node for the mic itself with no IOUSBHostInterface under it: on the bus, never enumerated (INFERRED shape)
    ioreg) printf '+-o USB Audio C270 HD@01110000  <class IOUSBHostDevice, id 0x1, registered>\n' >"$T/usb.txt"; : >"$T/log.txt" ;;
    none) : >"$T/usb.txt"; : >"$T/log.txt" ;;
    # OPD 4 shape (INFERRED, no real capture yet): the physical hub = USB2 half + USB3 half sharing the locationID prefix 01, BOTH with zero children; the dongle hangs off another port
    hub) ue_iousb hub_empty; printf '+-o Keyboard Dongle@02100000  <class IOUSBHostDevice, id 0x9, registered>\n' >"$T/usb.txt"; : >"$T/log.txt" ;;
    # healthy (INFERRED): the USB2 half carries a dongle, the USB3 half is empty. NOT evidence.
    hubok) ue_iousb hub_dongle; printf '+-o Keyboard Dongle@01120000  <class IOUSBHostDevice, id 0x5, registered>\n' >"$T/usb.txt"; : >"$T/log.txt" ;;
  esac
  [ "${AUTOL:-1}" = 1 ] && printf '#!/bin/bash\necho kioskuser\n' >"$T/bin/defaults" || printf '#!/bin/bash\nexit 1\n' >"$T/bin/defaults"
  case "${FDE:-off}" in
    off) printf '#!/bin/bash\necho "FileVault is Off."\n' >"$T/bin/fakefde" ;;
    on) printf '#!/bin/bash\necho "FileVault is On."\n' >"$T/bin/fakefde" ;;
    unknown) printf '#!/bin/bash\nexit 1\n' >"$T/bin/fakefde" ;;
  esac
  [ "${PRESENT:-0}" = 1 ] && printf 'USB Audio C270 HD\n' >"$T/usb.txt"   # on the bus but no CoreAudio input
  if [ -n "${LOGTXT+x}" ]; then printf '%b\n' "$LOGTXT" >"$T/log.txt"; fi   # a kernel-log fixture of the case's own (escapes expanded)
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
  s="$(ue_case CONST=0)"
  assert_eq "$s" "reboots=0 shutdowns=0 A=0 " "constant 0 (the shipped default): fully inert, not even a would_do (F4)"
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
  ue_log_now   # a second fault has its own kernel line (the first one is outside this episode's window)
  ue_tick; ue_tick
  assert_eq "$(ue_reboots)" "0" "inside 2 h: no reboot"
  assert_has "$(events)" 'blocked=reboot_cap_2h' "exact reason"
  # past 2 h: the shared d' budget (1 per IST day / USB_BUDGET_S) still holds the reboot (F5)
  : >"$CALLS"; : >"$T/pub.log"; rm -rf "$STATE_DIR/once"; rm -f "$STATE_DIR/usb_absent"
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 4000)); export GUARDIAN_FAKE_NOW
  ue_log_now
  usb_state_set_verify healed_pending
  ue_tick; ue_tick
  assert_eq "$(ue_reboots)" "0" "past 2 h but inside the d' budget: no second reboot"
  assert_has "$(events)" 'blocked=reboot_budget' "exact reason"
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
  # F6: only the whole output "FileVault is Off." (one line, nothing else) is off
  printf '#!/bin/bash\nprintf "FileVault is Off.\\nDeferred enablement appears to be active for user kiosk.\\n"\n' >"$T/bin/fakefde"
  assert_eq "$(root_do fde-status)" "unknown" "an extra line (deferred enablement) is unknown"
  printf '#!/bin/bash\nprintf "FileVault is On.\\nPlease enter the user name\\n"\n' >"$T/bin/fakefde"
  assert_eq "$(root_do fde-status)" "unknown" "On plus an extra line is unknown"
  printf '#!/bin/bash\nprintf "FileVault is Off.\\n"\n' >"$T/bin/fakefde"
  assert_eq "$(root_do fde-status)" "off" "the exact one line"
  # the verb refuses extra arguments, like reboot
  local rc; GUARDIAN_ROOT_TESTMODE=1 bash "$KDIR/bin/guardian-root.sh" fde-status extra >/dev/null 2>&1; rc=$?
  assert_eq "$rc" "2" "fde-status with an argument: refused rc 2"
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
  assert_eq "$(ue_case EVID=hub CONST=0)" "reboots=0 shutdowns=0 A=0 " "constant still holds (inert)"
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

# ============================ R2: the Opus refute R1 findings (F1-F8), refuter tests O1-O17 ported, and the builder-suite gaps ============================
n_log() { grep -c '^LOG show .*enumeration failure' "$CALLS"; }   # the ladder's kernel-log read (the collector's own 15 min d' probe is another call)
ev_ue() { events | grep -c 'usb_enum\|room_device_unplugged'; }
ue_state_files() { local n=0 f; for f in "$STATE_DIR"/usb-enum*; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }

# O1 / F4: flag OFF is FULLY inert: no kernel-log read, no ioreg hub read, no publish, no state file
test_ue_o1_flag_off_is_inert() {
  local s; s="$( ( export CONST=0 EVID=none; ue_setup; ue_tick; ue_tick; echo "log=$(n_log) ev=$(ev_ue) files=$(ue_state_files) iousb=$(grep -c 'ioreg -p IOUSB' "$CALLS")" ) )"
  assert_has "$s" 'log=0 ev=0 files=0 iousb=0' "USB_ENUM_HEAL=0: no log read, no events, no state files [$s]"
  s="$( ( export CONST=0 EVID=hub MODE=shadow; ue_setup; ue_tick; ue_tick; ue_tick; echo "log=$(n_log) ev=$(ev_ue) files=$(ue_state_files)" ) )"
  assert_has "$s" 'log=0 ev=0 files=0' "flag off in shadow with a hub fixture: still nothing [$s]"
  # a HEALTHY tick at flag 0 writes none of the ladder's state files (session, re-arm)
  s="$( ( export CONST=0; ue_setup; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; ue_tick; ue_tick; echo "files=$(ue_state_files)" ) )"
  assert_has "$s" 'files=0' "healthy tick at flag 0: no usb-enum state file [$s]"
  # a pending ladder stamp + a proven d' verify at flag 0: no post-boot heal line, the stamp is left alone
  s="$( ( export CONST=0; ue_setup; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"
    printf '%s true pending\n' "$((GUARDIAN_FAKE_NOW - 100))" >"$STATE_DIR/usb-enum-reboot"
    printf 'date=%s\nepoch=%s\nrecorder_pid=1\ncoreaudiod_pid=1\nboot_age_s=1\nport=p\nverify=healed_pending\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW - 100))" >"$STATE_DIR/usb-reboot"
    ue_tick; echo "ev=$(ev_ue) stamp=$(cat "$STATE_DIR/usb-enum-reboot")" ) )"
  assert_has "$s" 'ev=0 stamp=.* true pending' "flag 0: usb_enum_post_boot does nothing [$s]"
}

# O2 / F4: every verdict, hub included, is cached: the log read does not run on every tick
test_ue_o2_every_verdict_is_cached() {
  local s v
  for v in hub none hubok log; do
    s="$( ( export EVID=$v MODE=shadow; ue_setup; ue_tick; ue_tick; ue_tick; echo "n=$(n_log)" ) )"
    assert_has "$s" 'n=1$' "verdict from fixture $v cached for 300 s: one log read over 3 ticks [$s]"
  done
}

# would_do only with the constant at 1 and the mode not heal (or the kill switch / allowlist)
test_ue_f4_would_do_only_when_constant_is_one() {
  assert_has "$(ue_case MODE=shadow PRESENT=1 EVID=log)" 'blocked=mode_not_heal' "constant 1, shadow: would_do"
  assert_eq "$(ue_case CONST=0 MODE=shadow PRESENT=1 EVID=log)" "reboots=0 shutdowns=0 A=0 " "constant 0, shadow: nothing at all"
}

# F1: IOUSB-plane hub evidence. The fixture shapes are INFERRED (no real capture yet).
test_ue_f1_hub_parser_on_the_three_shapes() {
  ue_setup
  ue_iousb hub_healthy;  usb_enum_ioreg_emptyhub; assert_rc "$?" 1 "healthy: USB2 half has the C270 and a dongle, USB3 half empty: NO evidence"
  ue_iousb hub_dongle;   usb_enum_ioreg_emptyhub; assert_rc "$?" 1 "USB2 half with a dongle behind a port node, USB3 empty: NO evidence"
  ue_iousb hub_empty;    usb_enum_ioreg_emptyhub; assert_rc "$?" 0 "OPD 4: both halves empty, only the dongle on another port: evidence"
  ue_iousb nohub;        usb_enum_ioreg_emptyhub; assert_rc "$?" 1 "no hub at all: no evidence"
  ue_iousb hub_two;      usb_enum_ioreg_emptyhub; assert_rc "$?" 0 "a second physical hub with both halves empty is evidence even beside a healthy hub (grouped by locationID prefix)"
  ue_iousb usb2_half_only; usb_enum_ioreg_emptyhub; assert_rc "$?" 1 "one half only cannot be shown to be a whole physical hub: no evidence"
  : >"$T/iousb.txt";     usb_enum_ioreg_emptyhub; assert_rc "$?" 1 "empty capture: no evidence"
}

test_ue_f1_hub_evidence_at_the_ladder_level() {
  assert_has "$(ue_case EVID=hub)" 'reboots=1 shutdowns=1 A=1' "OPD 4 shape: rung A then one reboot"
  assert_has "$(ue_case EVID=hubok)" 'reboots=0 .*room_device_unplugged' "healthy hub shape (USB3 half empty, USB2 half populated): unplugged, no reboot"
  assert_has "$(ue_case EVID=none)" 'reboots=0 .*room_device_unplugged' "no hub: unplugged"
}

# O3 / O4: the USB3 half is empty on every healthy hub; children behind port nodes count
test_ue_o3_companion_usb3_hub_is_not_evidence() {
  local s; s="$( ( export EVID=none; ue_setup; ue_iousb hub_dongle; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*room_device_unplugged' "dongle behind the USB2 half: unplugged, no reboot [$s]"
}
test_ue_o4_children_behind_port_nodes_are_children() {
  local s; s="$( ( export EVID=none; ue_setup; ue_iousb hub_healthy; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*room_device_unplugged' "healthy hub, children behind port nodes: no evidence [$s]"
}

# O5 / F3: the mic IS on the bus, no input engine. An empty hub is rung C evidence only; the mic's own node without interfaces, or the mic's kernel line, is what counts.
test_ue_o5_no_input_with_only_hub_evidence_does_not_reboot() {
  local s; s="$( ( export EVID=none PRESENT=1; ue_setup; ue_iousb hub_empty; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "no_input + empty hubs only: no reboot [$s]"
  assert_not "$s" 'room_device_unplugged' "a device on the bus is never rung C"
}
test_ue_f3_noiface_must_be_the_mics_own_node() {
  local s
  s="$( ( export EVID=none; ue_setup
    printf '+-o USB Audio C270 HD@01110000  <class IOUSBHostDevice, id 0x1, registered>\n  | +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x2>\n+-o Unknown Device@01300000  <class IOUSBHostDevice, id 0x3, registered>\n' >"$T/usb.txt"
    ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "ANOTHER device without interfaces is not evidence for the mic [$s]"
  s="$( ( export EVID=none; ue_setup
    printf '+-o Unknown Device@01300000  <class IOUSBHostDevice, id 0x3, registered>\n+-o USB Audio C270 HD@01110000  <class IOUSBHostDevice, id 0x1, registered>\n' >"$T/usb.txt"
    ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=1' "the mic's own node without interfaces is evidence [$s]"
}

# O6 / F2: the kernel line must name the mic, say the failure, be this boot and inside the episode window
test_ue_o6_unrelated_usb_device_log_is_not_evidence() {
  local s
  s="$(ue_case PRESENT=1 'LOGTXT=2026-10-14 11:00:00.104 Df  kernel[0:694] [com.apple.usb:all] Logitech USB Receiver: hardware connection lost')"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "unrelated USB receiver lost: no reboot [$s]"
}
test_ue_f2_kernel_log_rules() {
  local now s; now="$(ist_epoch 11:00)"
  tsf() { ue_ts "$((now + $1))"; }
  s="$(ue_case PRESENT=1 "LOGTXT=$(tsf 0).1 Df  kernel[0:694] [com.apple.usb:all] USB2 Hub: enumeration failure")"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "a hub's enumeration failure is not the mic's [$s]"
  s="$(ue_case PRESENT=1 "LOGTXT=$(tsf 0).1 Df  kernel[0:694] [com.apple.usb:all] c270 webcam: hardware connection lost")"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "the pattern is case-sensitive like conf.sh [$s]"
  s="$(ue_case PRESENT=1 "LOGTXT=$(tsf 0).1 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: link retrained")"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "the mic named, but not a failure message [$s]"
  s="$(ue_case PRESENT=1 "LOGTXT=$(tsf 0).1 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: enumeration failure")"
  assert_has "$s" 'reboots=1' "the mic + enumeration failure, this boot, inside the window [$s]"
  s="$(ue_case PRESENT=1 "LOGTXT=$(tsf -400).1 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost")"
  assert_has "$s" 'reboots=1' "a line 400 s before the episode (inside the 10 min allowance) counts [$s]"
  s="$(ue_case PRESENT=1 "LOGTXT=$(tsf -3600).1 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost")"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "a line an hour before the episode (same boot) is too old [$s]"
  # a line from the previous boot: the boot began 5 min before the tick, the line is 30 min old
  s="$(ue_case PRESENT=1 FAKE_BOOT_AGE=320 "LOGTXT=$(tsf -480).1 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost")"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "a previous-boot line (inside the 10 min window, before this boot) never counts [$s]"
  # TONOR kiosk: the class pattern is the mic's name
  s="$(ue_case PRESENT=1 USB_MIC_PATTERN=TONOR "LOGTXT=$(tsf 0).1 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost")"
  assert_has "$s" 'reboots=0' "with the tonor class a C270 line is another device [$s]"
}
test_ue_f2_log_read_window_is_narrowed() {
  ue_setup; ue_tick
  assert_has "$(grep '^LOG show .*enumeration failure' "$CALLS" | head -1)" '--start 20' "log show uses --start, not a 24 h window"
  assert_not "$(grep '^LOG show .*enumeration failure' "$CALLS" | head -1)" '24h' "no 24 h read"
}

# O7 / F5: one budget with d': a d' reboot 30 min ago (healed) leaves no second reboot for the ladder; and the reverse
test_ue_o7_dprime_reboot_30min_ago_blocks_the_ladder() {
  local s; s="$( ( ue_setup
    printf 'date=%s\nepoch=%s\nrecorder_pid=1\ncoreaudiod_pid=1\nboot_age_s=1\nport=p\nverify=healed_pending\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW - 1800))" >"$STATE_DIR/usb-reboot"
    ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*blocked=reboot_budget' "d' already spent the usb-reboot budget [$s]"
}
test_ue_f5_ladder_reboot_spends_the_dprime_budget() {
  ue_setup; ue_tick
  assert_eq "$(ue_reboots)" "1" "the ladder rebooted"
  assert_eq "$(usb_budget_state "$(ist_date)")" "today" "d' sees the budget spent by the ladder's state write"
  USB_REBOOT_ISSUED=0; : >"$T/pub.log"
  assert_eq "$(usb_budget_state "$(ist_date)")" "today" "so heal_usb_power_off would refuse (it requires none)"
}

# O8 / F6: FileVault deferred enablement is not "Off."
test_ue_o8_filevault_deferred_enablement_is_not_off() {
  local s; s="$( ( ue_setup
    printf '#!/bin/bash\nprintf "FileVault is Off.\\nDeferred enablement appears to be active for user kiosk.\\n"\n' >"$T/bin/fakefde"
    ue_tick; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*blocked=filevault_unknown' "deferred enablement: no reboot [$s]"
}

# O9 / F7: rung C in shadow (and with the kill switch): one line per episode, not every 5 min
test_ue_o9_rung_c_shadow_not_every_5min() {
  local s; s="$( ( export EVID=none MODE=shadow; ue_setup; local i; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 300)); ue_tick; done; echo "n=$(events | grep -c room_device_unplugged)" ) )"
  assert_has "$s" 'n=1$' "one line per episode over 1 h of shadow ticks [$s]"
  s="$( ( export EVID=none MODE=kill; ue_setup; local i; for i in 1 2 3 4 5 6 7 8; do GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 300)); ue_tick; done; echo "n=$(events | grep -c room_device_unplugged)" ) )"
  assert_has "$s" 'n=1$' "kill switch engaged: one line per episode [$s]"
  # the kill switch clears mid-episode: the escalation itself is still due once
  s="$( ( export EVID=none MODE=kill; ue_setup; ue_tick; ue_mode heal; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 700)); ue_tick; ue_tick
    echo "esc=$(events | grep -c '"action":"escalate".*room_device_unplugged')" ) )"
  assert_has "$s" 'esc=1' "heal mode after a would_do: the escalate still goes out once [$s]"
}

# O10 run mode cannot be flipped by env
test_ue_o10_runmode_ignores_env() {
  local s; s="$( ( export GUARDIAN_TEST_USB_ENUM_HEAL=1 USB_ENUM_HEAL=1 GUARDIAN_TEST_SENTINEL_HEAL_CODES="x" SENTINEL_HEAL_CODES="x"; G_RUNMODE=1; . "$KDIR/lib/common.sh" 2>/dev/null; echo "h=$USB_ENUM_HEAL c=$SENTINEL_HEAL_CODES" ) )"
  assert_eq "$s" "h=0 c=usb_enum_reboot" "run mode: 0 and the fixed allowlist"
}

# O11 the fde seam only in test mode
test_ue_o11_fde_seam_needs_testmode() {
  # portable: a real /usr/bin/fdesetup may exist (macOS) and say Off. The seam writes a marker when it runs; without test mode it must never run, whatever the verdict.
  local s f; f="$T/seam-marker-bin"
  printf '#!/bin/bash\ntouch "%s/seam-ran"\necho "FileVault is Off."\n' "$T" >"$f"; chmod +x "$f"
  s="$(env -u GUARDIAN_ROOT_TESTMODE GUARDIAN_FDESETUP_BIN="$f" bash "$KDIR/bin/guardian-root.sh" fde-status 2>/dev/null)"
  assert_eq "$([ -e "$T/seam-ran" ] && echo ran || echo not-run)" not-run "seam binary never run without GUARDIAN_ROOT_TESTMODE [$s]"
  case "$s" in on|off|unknown) ok ;; *) fail "verdict is not one of on|off|unknown: [$s]" ;; esac
  s="$(GUARDIAN_ROOT_TESTMODE=1 GUARDIAN_FDESETUP_BIN="$f" bash "$KDIR/bin/guardian-root.sh" fde-status 2>/dev/null)"
  assert_eq "$([ -e "$T/seam-ran" ] && echo ran || echo not-run)" ran "control: with test mode the seam is run [$s]"
}

# O12 session_was_open is taken from the last healthy tick before the fault
test_ue_o12_session_was_open_from_before_the_fault() {
  local s; s="$( ( ue_setup; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"
    write_status capture_open=true; collect_all; heal_cycle >/dev/null 2>&1
    : >"$T/usb.txt"; : >"$T/engine.txt"; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 30)); export GUARDIAN_FAKE_NOW
    printf '%s.104 Df  kernel[0:694] [com.apple.usb:all] C270 HD WEBCAM: hardware connection lost\n' "$(ue_ts "$GUARDIAN_FAKE_NOW")" >"$T/log.txt"
    write_status capture_open=false
    ue_tick; events | grep -o 'reboot_pending session_was_open=[a-z]*' ) )"
  assert_has "$s" 'session_was_open=true' "open before the fault [$s]"
}

# O13 a rung A that did not restart coreaudiod is not "rung A done": no reboot
test_ue_o13_failed_rung_a_never_reboots() {
  local s; s="$( ( ue_setup; gsleep() { return 0; }; echo 4242 >"$T/ca_pid"; ue_tick; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0' "coreaudiod never restarted: no reboot [$s]"
}

# O14 the G6 cap full: no reboot
test_ue_o14_g6_cap_blocks() {
  local s; s="$( ( ue_setup; local i; for i in 1 2 3; do echo "$GUARDIAN_FAKE_NOW x:y" >>"$STATE_DIR/actions"; done; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 shutdowns=0 A=0' "3 actions in the hour: nothing [$s]"
}

# O15 flag OFF keeps the old coreaudio_no_device kill path (heal_cycle loop)
test_ue_o15_flag_off_keeps_old_coreaudiod_kill() {
  local s; s="$( ( export CONST=0 PRESENT=1 EVID=none; ue_setup; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 shutdowns=0 A=[1-9]' "old heal_coreaudiod path still runs with the constant 0 [$s]"
}

# O16 / M22: capture opens AFTER rung A ran (tick 1 blocked at autologin); tick 2: no reboot
test_ue_o16_capture_opens_after_rung_a() {
  local s; s="$( ( export AUTOL=0; ue_setup; ue_tick; printf '#!/bin/bash\necho kioskuser\n' >"$T/bin/defaults"; export CAP=true; : >"$CALLS"; rm -rf "$STATE_DIR/once"; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*blocked=capture_open' "capture open after rung A: no reboot [$s]"
}

# O17 / M06: a d' reboot whose verify is still pending blocks the ladder
test_ue_o17_dprime_verify_pending_blocks() {
  local s; s="$( ( ue_setup
    printf 'date=%s\nepoch=%s\nrecorder_pid=1\ncoreaudiod_pid=1\nboot_age_s=1\nport=p\nverify=pending\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW - 100))" >"$STATE_DIR/usb-reboot"
    ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*blocked=verify_pending' "d' verify pending [$s]"
}

# F8: every guard is re-read after the last publish and before the root call. ue_flip_case <what>: a thing changes exactly at the point the ladder announces the reboot.
ue_flip_case() { # device | kill | capture
  ( ue_setup
    eval "$(declare -f audit | sed '1s/^audit/orig_audit/')"
    eval "$(declare -f capture_idle | sed '1s/^capture_idle/orig_capture_idle/')"
    audit() { orig_audit "$@"; case "$*" in *"issuing reboot"*) : >"$T/flip" ;; esac; }
    case "$1" in
      device) usb_present_now() { [ -e "$T/flip" ] && return 0; return 1; } ;;
      kill) act_step() { [ -e "$T/flip" ] && return 1; return 0; } ;;
      capture) capture_idle() { [ -e "$T/flip" ] && return 1; orig_capture_idle; } ;;
      nopublish) usb_present_now() { events | grep -c reboot_pending >"$T/pub_before_reread"; return 1; } ;;
    esac
    ue_tick
    echo "$(ue_summary) pub=$(cat "$T/pub_before_reread" 2>/dev/null) state=$(cat "$STATE_DIR/usb-reboot" 2>/dev/null | tr '\n' ',') stamp=$(cat "$STATE_DIR/usb-enum-reboot" 2>/dev/null)" )
}
test_ue_f8_device_back_before_the_root_call_aborts() {
  local s; s="$(ue_flip_case device)"
  assert_has "$s" 'reboots=0 shutdowns=0' "the mic came back between publish and call: no reboot [$s]"
  assert_has "$s" 'verify=void' "the usb-reboot state is restored (budget not spent) [$s]"
  assert_has "$s" 'stamp=$' "no 2 h stamp for a reboot that did not happen [$s]"
}
test_ue_f8_kill_switch_engaged_before_the_root_call_aborts() {
  local s; s="$(ue_flip_case kill)"
  assert_has "$s" 'reboots=0 shutdowns=0' "kill switch re-read: no reboot [$s]"
  assert_has "$s" 'verify=void' "state restored [$s]"
}
test_ue_f8_capture_opened_before_the_root_call_aborts() {
  local s; s="$(ue_flip_case capture)"
  assert_has "$s" 'reboots=0 shutdowns=0' "capture state re-read: no reboot [$s]"
}
test_ue_f8_the_publish_happens_before_the_reread() {
  local s; s="$(ue_flip_case nopublish)"
  assert_has "$s" 'pub=1' "reboot_pending is already published when the presence re-read runs [$s]"
  assert_has "$s" 'reboots=1' "all re-reads agree: the reboot goes out [$s]"
}

# ---- R3: ported from the R2 Opus refuter (N2). ALL ioreg / log shapes are INFERRED. ----
n_logs() { grep -c '^LOG show --start' "$CALLS"; }
test_ue_r2_f8_slow_to_root_aborts() {
  local s; s="$( ( ue_setup
    eval "$(declare -f act_step | sed '1s/^act_step/orig_act_step/')"
    act_step() { orig_act_step || return 1; : >"$T/adv"; return 0; }
    now_epoch() { local c; if [ -e "$T/adv" ]; then c="$(cat "$T/advc" 2>/dev/null || echo 0)"; echo "$((GUARDIAN_FAKE_NOW + c))"; echo "$((c + 2))" >"$T/advc"; else echo "$GUARDIAN_FAKE_NOW"; fi; }
    ue_tick; echo "$(ue_summary) $(events | grep -o 'aborted_[a-z_]*') stamp=$(cat "$STATE_DIR/usb-enum-reboot")" ) )"
  assert_has "$s" 'reboots=0 .*aborted_slow_to_root stamp=$' "2 s after the last read: abort, no stamp [$s]"
}
test_ue_r2_hub_cache_not_reused_for_no_input() {
  local s; s="$( ( export EVID=hub MODE=shadow; ue_setup; ue_tick; ue_mode heal; : >"$CALLS"; : >"$T/pub.log"; rm -rf "$STATE_DIR/once"
    printf 'USB Audio C270 HD\n' >"$T/usb.txt"; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0' "hub verdict for absent not used for no_input [$s]"
}
test_ue_r2_log_window_follows_episode() {
  local s; s="$( ( export PRESENT=1 EVID=none; ue_setup; echo "$((GUARDIAN_FAKE_NOW - 1800))" >"$STATE_DIR/usb-enum-episode"
    printf '%s.1 Df kernel C270 HD WEBCAM: enumeration failure\n' "$(ue_ts "$((GUARDIAN_FAKE_NOW - 2100))")" >"$T/log.txt"; ue_tick; ue_reboots ) )"
  assert_eq "$s" 1 "line 5 min before an episode that began 30 min ago counts"
  s="$( ( export PRESENT=1 EVID=none; ue_setup; echo "$((GUARDIAN_FAKE_NOW - 1800))" >"$STATE_DIR/usb-enum-episode"
    printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; ue_tick
    : >"$T/engine.txt"; printf '%s.1 Df kernel C270 HD WEBCAM: enumeration failure\n' "$(ue_ts "$((GUARDIAN_FAKE_NOW - 1500))")" >"$T/log.txt"; ue_tick; ue_reboots ) )"
  assert_eq "$s" 0 "a healthy tick ends the episode: a line from the old episode no longer counts"
}
test_ue_r2_rung_c_rearms_after_healthy_tick() {
  local s; s="$( ( export EVID=none MODE=shadow; ue_setup; ue_tick; ue_tick
    printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; ue_tick
    : >"$T/usb.txt"; : >"$T/engine.txt"; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 60)); ue_tick; ue_tick; events | grep -c room_device_unplugged ) )"
  assert_eq "$s" 2 "two episodes, two lines"
}
test_ue_r2_f8_presence_reread_timeout_aborts() {
  local s; s="$( ( ue_setup; usb_present_now() { sleep 3; return 1; }; ue_tick; echo "$(ue_summary) $(events | grep -o 'aborted_[a-z_]*')" ) )"
  assert_has "$s" 'reboots=0 .*aborted_device_changed' "timeout = abort [$s]"
}
test_ue_r2_unknown_boot_age_no_log_evidence() {
  local s; s="$( ( export PRESENT=1 EVID=none; ue_setup; printf '#!/bin/bash\nexit 1\n' >"$T/bin/sysctl"; chmod +x "$T/bin/sysctl"
    printf '%s.1 Df kernel C270 HD WEBCAM: enumeration failure\n' "$(ue_ts "$GUARDIAN_FAKE_NOW")" >"$T/log.txt"; ue_tick; echo "$(ue_summary) logs=$(n_logs)" ) )"
  assert_has "$s" 'reboots=0 .*logs=0' "boot age unknown: no log read, no reboot [$s]"
}

# N1: the kernel-log verdict is cached per EPISODE, whatever the fault kind
test_ue_n1_flapping_kind_reads_the_log_once() {
  local s; s="$( ( export EVID=none MODE=shadow; ue_setup; for i in 1 2 3 4 5 6 7 8 9 10; do
      if [ $((i % 2)) = 0 ]; then printf 'USB Audio C270 HD\n' >"$T/usb.txt"; else : >"$T/usb.txt"; fi; ue_tick; done; n_logs ) )"
  assert_eq "$s" 1 "10 ticks flapping absent/no_input: one log read"
}
test_ue_n1_log_reread_after_300s_and_in_a_new_episode() {
  local s; s="$( ( export EVID=none MODE=shadow; ue_setup; ue_tick; ue_tick; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 320)); export GUARDIAN_FAKE_NOW; ue_tick; n_logs ) )"
  assert_eq "$s" 2 "episode still on after 300 s: one more read"
  s="$( ( export EVID=none MODE=shadow; ue_setup; ue_tick
    printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; ue_tick
    : >"$T/usb.txt"; : >"$T/engine.txt"; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 60)); export GUARDIAN_FAKE_NOW; ue_tick; ue_tick; n_logs ) )"
  assert_eq "$s" 2 "a healthy tick ends the episode: the next fault episode reads again"
}
# Obs: rung B would_do in shadow / kill switch is published once per episode, not every 300 s
test_ue_obs_rung_b_shadow_would_do_once_per_episode() {
  local m s; for m in shadow kill; do
    s="$( ( export EVID=log MODE=$m; ue_setup; for i in $(seq 1 14); do ue_log_now; ue_tick; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 280)); export GUARDIAN_FAKE_NOW; done; events | grep -c 'would_do.*usb_enum_reboot' ) )"
    assert_eq "$s" 1 "mode $m: one rung B would_do over 70 min"; done
  s="$( ( export EVID=log MODE=shadow; ue_setup; ue_log_now; ue_tick
    printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"; ue_tick; : >"$T/usb.txt"; : >"$T/engine.txt"
    GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 60)); export GUARDIAN_FAKE_NOW; ue_log_now; ue_tick; events | grep -c 'would_do.*usb_enum_reboot' ) )"
  assert_eq "$s" 2 "a new episode publishes again"
}

# every verdict is cached: the IOUSB read (hub evidence) runs once over three ticks, not on every tick (the log read has its own per-episode cache)
test_ue_n1_hub_verdict_is_cached_per_kind() {
  local s; s="$( ( export EVID=hub MODE=shadow; ue_setup
    printf '#!/bin/bash\ncase "$*" in *"-p IOUSB"*) echo IOUSBREAD >>"%s/ioreads" ;; esac\ncat "%s/iousb.txt" 2>/dev/null\n' "$T" "$T" >"$T/bin/ioreg"; chmod +x "$T/bin/ioreg"
    ue_tick; ue_tick; ue_tick; grep -c IOUSBREAD "$T/ioreads" ) )"
  assert_eq "$s" 1 "one IOUSB read over 3 ticks"
}
