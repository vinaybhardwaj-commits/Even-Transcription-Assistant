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
    hub) ue_iousb hub_empty; [ "${CONST:-1}" = 0 ] || printf '01110000\n' >"$USB_ENUM_LOC"; printf '+-o Keyboard Dongle@02100000  <class IOUSBHostDevice, id 0x9, registered>\n' >"$T/usb.txt"; : >"$T/log.txt" ;;
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
  ue_attest "${ATT:-fresh}"
  write_status capture_open="${CAP:-false}"
  ue_mode "${MODE:-heal}"
}
# AMENDMENT 1: the fleet-written attestation file. ATT fresh|stale|writable|groupw|none|symlink|future|foreign
ue_attest() {
  local f="$FLAG_DIR/reboot-attested" t="$GUARDIAN_FAKE_NOW"
  rm -f "$f"; [ "$1" = none ] && return 0
  case "$1" in stale) t=$((GUARDIAN_FAKE_NOW - 8 * 86400)) ;; future) t=$((GUARDIAN_FAKE_NOW + 3600)) ;; esac
  if [ "$1" = symlink ]; then printf 'x\n' >"$FLAG_DIR/real-att"; ln -s "$FLAG_DIR/real-att" "$f"; return 0; fi
  printf 'attested\n' >"$f"
  case "$1" in writable) chmod 666 "$f" ;; groupw) chmod 660 "$f" ;; foreign) chmod 600 "$f" ;; *) chmod 600 "$f" ;; esac
  touch -d "@$t" "$f" 2>/dev/null || touch -t "$(date -r "$t" '+%Y%m%d%H%M.%S')" "$f"
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
  write_status capture_open="${CAP:-false}" state="${UE_STATE:-recording}" err="${UE_ERR:-}" extra="${UE_EXTRA:-}"
  rm -f "$STATE_DIR/flags.cache"; flag_fetch; collect_all
  GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 20)); export GUARDIAN_FAKE_NOW
  write_status capture_open="${CAP:-false}" state="${UE_STATE:-recording}" err="${UE_ERR:-}" extra="${UE_EXTRA:-}"
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
  assert_has "$(ue_case_a AUTOL=0)" 'reboots=0 .*blocked=preflight_autologin' "no autoLoginUser"
  assert_has "$(ue_case_a FDE=on)" 'reboots=0 .*blocked=preflight_fv' "FileVault on"
  assert_has "$(ue_case_a FDE=unknown)" 'reboots=0 .*blocked=preflight_fv' "FileVault unknown is off-limits"
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
  assert_not "$(cat "$CALLS")" 'start_""day\|restart_engine\|^room-recorder\|launchctl kickstart' "no room command and no kickstart from the kiosk (R4: the rung R bootout/bootstrap relaunch is the one recorder action)"
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
  ue_iousb hub_healthy;  usb_enum_ioreg_emptyhub 01; assert_rc "$?" 1 "healthy: USB2 half has the C270 and a dongle, USB3 half empty: NO evidence"
  ue_iousb hub_dongle;   usb_enum_ioreg_emptyhub 01; assert_rc "$?" 1 "USB2 half with a dongle behind a port node, USB3 empty: NO evidence"
  ue_iousb hub_empty;    usb_enum_ioreg_emptyhub 01; assert_rc "$?" 0 "OPD 4: both halves empty, only the dongle on another port: evidence"
  ue_iousb nohub;        usb_enum_ioreg_emptyhub 01; assert_rc "$?" 1 "no hub at all: no evidence"
  ue_iousb hub_two;      usb_enum_ioreg_emptyhub 03; assert_rc "$?" 0 "a second physical hub with both halves empty is evidence even beside a healthy hub (grouped by locationID prefix)"
  usb_enum_ioreg_emptyhub 01; assert_rc "$?" 1 "R5: the healthy hub (prefix 01) is not evidence just because another hub is empty"
  usb_enum_ioreg_emptyhub ""; assert_rc "$?" 1 "R5: no stamped mic location: no hub evidence"
  ue_iousb usb2_half_only; usb_enum_ioreg_emptyhub 01; assert_rc "$?" 1 "one half only cannot be shown to be a whole physical hub: no evidence"
  : >"$T/iousb.txt";     usb_enum_ioreg_emptyhub 01; assert_rc "$?" 1 "empty capture: no evidence"
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
  assert_has "$s" 'reboots=0 .*blocked=preflight_fv' "deferred enablement: no reboot [$s]"
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
    act_step() { orig_act_step || return 1; [ "$ACT_LAYER" = usb ] && : >"$T/adv"; return 0; }
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


# ---- R4: ruled rung order W -> R (recorder relaunch) -> A (coreaudiod) -> B (idle-gated reboot) -> needs_hands. ALL ioreg / log / status shapes are INFERRED. ----
# rec_failed scenario: the mic is on the bus WITH an input engine; only the recorder reports the tapewriter start failure.
UE_SIG1='tapewriter exited with status 1'
UE_SIGIO='avfaudio error -536870163'
ue_rf() { # knob=value ... : fresh rec_failed scenario, no tick yet
  export UE_STATE=failed UE_ERR="$UE_SIG1: $UE_SIGIO" EVID=none PRESENT=1
  for kv in "$@"; do export "${kv?}"; done
  ue_setup; printf 'C270 engine\n' >"$T/engine.txt"
}
ue_rf_case() { ( ue_rf "$@"; ue_tick; ue_summary; echo "boot=$(ue_n 'launchctl bootout') bs=$(ue_n 'launchctl bootstrap') kick=$(ue_n 'launchctl kickstart') nh=$(ue_nh)" ) | tr '\n' ' '; }
ue_n() { grep -c "^$1" "$CALLS"; }
ue_nh() { events | grep -c '"reason":"needs_hands"'; }
# a recorder that comes back after the relaunch: the status turns healthy and the tape grows once the poll window starts
ue_rf_recovers() {
  gsleep() { case "$1" in 10) UE_STATE=recording; UE_ERR=""; write_status capture_open=false; tape_stats_2s() { echo "-30.0 0.1 0.2"; } ;; *) echo "$((10000 + RANDOM))" >"$T/ca_pid" ;; esac; return 0; }
}

test_ue_r4_rung_order_end_to_end_relaunch_then_coreaudiod_then_reboot() {
  local s; s="$( ( ue_rf; ue_tick; ue_summary; echo "ORDER $(grep -n '^launchctl bootout\|^launchctl bootstrap\|coreaudiod-kill\|guardian-root.sh reboot$' "$CALLS" | sed 's/^[0-9]*://' | tr '\n' ',')" ) )"
  assert_has "$s" 'reboots=1 shutdowns=1 A=1' "recorder failed: relaunch did not cure it, rung A ran, then one reboot [$s]"
  assert_has "$s" 'ORDER launchctl bootout.*launchctl bootstrap.*coreaudiod-kill.*reboot' "order: bootout, bootstrap, coreaudiod kill, reboot [$s]"
  assert_eq "$(ue_rf_case | grep -o 'kick=[0-9]*')" "kick=0" "never kickstart"
}

test_ue_r4_rung_w_waits_while_the_marker_is_present_then_continues() {
  local s; s="$( ( ue_rf UE_EXTRA=',"device_state":"not_responding"'; ue_tick; ue_tick; ue_summary; echo "boot=$(ue_n 'launchctl bootout') wait=$(events | grep -c usb_enum_wait)"
    GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 780)); export GUARDIAN_FAKE_NOW; ue_tick; echo "T880 boot=$(ue_n 'launchctl bootout')"
    GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 100)); export GUARDIAN_FAKE_NOW; ue_tick; echo "T920 boot=$(ue_n 'launchctl bootout') reboots=$(ue_reboots)" ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=0 shutdowns=0 A=0 .*boot=0 wait=1 ' "marker present: no action, one wait line over two ticks [$s]"
  assert_has "$s" 'T880 boot=0' "still inside the 15 min [$s]"
  assert_has "$s" 'T920 boot=1 reboots=1' "after 15 min the ladder continues with R [$s]"
  s="$(ue_rf_case)"
  assert_has "$s" 'boot=1' "marker absent (today's recorder): W is skipped, R runs at once [$s]"
}

test_ue_r4_rung_r_guards_skip_with_the_exact_reason() {
  assert_has "$(ue_rf_case CAP=true)" 'reboots=0 .*blocked=capture_open.*boot=0 bs=0' "capture open: no relaunch, exact reason"
  assert_has "$(ue_rf_case MODE=shadow)" 'reboots=0 .*blocked=mode_not_heal.*boot=0' "shadow: no relaunch"
  assert_has "$(ue_rf_case MODE=kill)" 'reboots=0 .*blocked=killswitch.*boot=0' "kill switch: no relaunch"
  assert_has "$(ue_rf_case ALLOW=)" 'reboots=0 .*blocked=code_not_allowlisted.*boot=0' "allowlist: no relaunch"
  assert_has "$(ue_rf_case CONST=0)" 'reboots=0 shutdowns=0 A=0 *boot=0 bs=0 kick=0 nh=0' "flag 0: nothing"
}

test_ue_r4_relaunch_is_once_per_episode_and_never_with_capture_open() {
  local s; s="$( ( ue_rf; ue_tick; ue_tick; ue_tick; echo "boot=$(ue_n 'launchctl bootout')" ) )"
  assert_has "$s" 'boot=1' "three ticks of one episode: one relaunch [$s]"
  s="$( ( ue_rf CAP=true; ue_tick; ue_tick; ue_tick; echo "boot=$(ue_n 'launchctl bootout') relaunch_events=$(events | grep -c usb_enum_relaunch)" ) )"
  assert_has "$s" 'boot=0 relaunch_events=0' "capture open on every tick: never a relaunch, not even an attempt event [$s]"
  # a capture that opens after R decided: R does not repeat; A and B still refuse
  s="$( ( ue_rf; ue_tick; CAP=true; : >"$CALLS"; ue_tick; echo "boot=$(ue_n 'launchctl bootout') reboots=$(ue_reboots)" ) )"
  assert_has "$s" 'boot=0 reboots=0' "later tick with capture open: nothing [$s]"
}

test_ue_r4_relaunch_that_cures_it_stops_the_ladder() {
  local s; s="$( ( ue_rf; ue_rf_recovers; ue_tick; ue_summary; echo "boot=$(ue_n 'launchctl bootout')"; ue_tick; echo "healed=$(events | grep -c usb_enum_relaunch)" ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=0 shutdowns=0 A=0 .*boot=1' "recorder back and producing tape inside the window: no rung A, no reboot [$s]"
  assert_has "$s" 'healed=[2-9]' "the relaunch and the heal report are published [$s]"
}

test_ue_r4_same_signature_relaunch_inside_30_min_is_skipped() {
  local s now
  s="$( ( ue_rf; printf '%s 1\n' "$((GUARDIAN_FAKE_NOW - 600))" >"$STATE_DIR/usb-enum-rl"; ue_tick; ue_summary; echo "boot=$(ue_n 'launchctl bootout')" ) | tr '\n' ' ')"
  assert_has "$s" 'blocked=relaunch_same_signature_30m.*boot=0' "a relaunch under 0xE00002ED 10 min ago: skipped with the exact reason [$s]"
  assert_has "$s" 'A=1' "rung A still runs after the skip [$s]"
  s="$( ( ue_rf; printf '%s 1\n' "$((GUARDIAN_FAKE_NOW - 1900))" >"$STATE_DIR/usb-enum-rl"; ue_tick; echo "boot=$(ue_n 'launchctl bootout')" ) )"
  assert_has "$s" 'boot=1' "31 min ago: relaunch again [$s]"
  s="$( ( ue_rf; printf '%s 0\n' "$((GUARDIAN_FAKE_NOW - 600))" >"$STATE_DIR/usb-enum-rl"; ue_tick; echo "boot=$(ue_n 'launchctl bootout')" ) )"
  assert_has "$s" 'boot=1' "the earlier relaunch was a different signature: relaunch [$s]"
  s="$( ( ue_rf UE_ERR="$UE_SIG1"; printf '%s 1\n' "$((GUARDIAN_FAKE_NOW - 600))" >"$STATE_DIR/usb-enum-rl"; ue_tick; echo "boot=$(ue_n 'launchctl bootout')" ) )"
  assert_has "$s" 'boot=1' "this error has no 0xE00002ED code: the skip does not apply [$s]"
  s="$( ( ue_rf; ue_tick; echo "rl=$(cat "$STATE_DIR/usb-enum-rl")" ) )"
  assert_has "$s" 'rl=[0-9]* 1' "the relaunch stamp records the signature [$s]"
}

test_ue_r4_tapewriter_signature_triggers() {
  assert_has "$(ue_rf_case UE_ERR='tapewriter exited with status 1')" 'boot=1' "tapewriter exited with status 1"
  assert_has "$(ue_rf_case UE_ERR='physical_fallback_required: no input')" 'boot=1' "physical_fallback_required"
  assert_has "$(ue_rf_case UE_ERR='avfaudio error -536870163')" 'boot=1' "-536870163"
  assert_has "$(ue_rf_case UE_ERR='something else entirely')" 'reboots=0 shutdowns=0 A=0 *boot=0' "another last_error: no trigger"
  assert_has "$(ue_rf_case UE_STATE=recording)" 'reboots=0 shutdowns=0 A=0 *boot=0' "signature but state is not failed: no trigger"
}

test_ue_r4_kernel_usb_errors_tag_the_episode_and_count_as_evidence() {
  local s; s="$( ( ue_rf UE_ERR="$UE_SIG1"; printf '%s.9 Df  kernel[0:1] [com.apple.usb:all] AppleUSBIORequest: AppleUSBIORequest::complete: device 2 (C270 HD WEBCAM@01100000) endpoint 0x00: status 0xe00002ed (transaction error)\n' "$(ue_ts "$GUARDIAN_FAKE_NOW")" >"$T/log.txt"
    ue_tick; ue_summary; events | grep -c usb_bus_event ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=1 ' "kernel AppleUSBIORequest error near the failure is evidence: reboot [$s]"
  assert_has "$s" ' [1-9][0-9]* $' "the events carry usb_bus_event=true [$s]"
  s="$( ( ue_rf UE_ERR="$UE_SIG1"; ue_tick; ue_summary ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence' "no kernel error, no IOKit code, no mic line: no evidence, no reboot [$s]"
  s="$( ( ue_rf UE_ERR="$UE_SIG1"; printf '%s.9 Df  kernel[0:1] AppleUSBIORequest: x\n' "$(ue_ts "$((GUARDIAN_FAKE_NOW - 600))")" >"$T/log.txt"; ue_tick; ue_summary ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=0 ' "a kernel error 10 min before the failure is outside +-60 s [$s]"
  s="$( ( ue_rf; ue_tick; ue_summary ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=1 ' "the IOKit not-responding code in last_error is itself evidence [$s]"
}

test_ue_r4_needs_hands_once_per_episode() {
  local s; s="$( ( ue_rf FDE=on; ue_tick; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 700)); export GUARDIAN_FAKE_NOW; ue_tick; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 700)); export GUARDIAN_FAKE_NOW; ue_tick; ue_summary; echo "nh=$(ue_nh)"; events | grep -o 'unplug_5s_same_port' | head -1 ) | tr '\n' ' ')"
  assert_has "$s" 'blocked=preflight_fv.* nh=1 unplug_5s_same_port' "reboot cannot apply (FileVault on): needs_hands once over three ticks spaced past the 10 min escalate dedupe, with the instruction [$s]"
  assert_has "$s" 'reboots=0' "and no reboot [$s]"
  s="$( ( ue_rf HID=20; ue_tick; ue_tick; echo "nh=$(ue_nh)" ) )"
  assert_has "$s" 'nh=0' "a transient guard (HID busy) is a wait, not needs_hands [$s]"
  s="$( ( ue_rf FDE=on; ue_tick; export UE_STATE=recording UE_ERR=""; ue_tick; GUARDIAN_FAKE_NOW=$((GUARDIAN_FAKE_NOW + 700)); export GUARDIAN_FAKE_NOW; export UE_STATE=failed UE_ERR="$UE_SIG1: $UE_SIGIO"; ue_tick; echo "nh=$(ue_nh)" ) )"
  assert_has "$s" 'nh=2' "a new episode (healthy tick between, past the 10 min escalate dedupe) escalates again [$s]"
  s="$( ( ue_rf; printf 'USB Audio C270 HD@14100000  <class IOUSBHostDevice, id 0x1, registered>\n' >"$T/usb.txt"; EVID=none; export FDE=on; ue_rf FDE=on; printf '+-o USB Audio C270 HD@14100000  <class IOUSBHostDevice, id 0x1, registered>\n' >"$T/usb.txt"; ue_tick; events | grep -o 'usb_location_id=[0-9a-f]*' | head -1 ) )"
  assert_has "$s" 'usb_location_id=14100000' "the message carries the device location id [$s]"
}

test_ue_r4_failed_reboot_verify_escalates_needs_hands_once() {
  local s; s="$( ( ue_setup; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; : >"$T/engine.txt"; rm -f "$T/usb.txt"; : >"$T/usb.txt"
    printf '%s true pending\n' "$((GUARDIAN_FAKE_NOW - 700))" >"$STATE_DIR/usb-enum-reboot"
    printf 'date=%s\nepoch=%s\nrecorder_pid=1\ncoreaudiod_pid=1\nboot_age_s=1\nport=p\nverify=failed\n' "$(ist_date)" "$((GUARDIAN_FAKE_NOW - 700))" >"$STATE_DIR/usb-reboot"
    usb_enum_post_boot; usb_enum_post_boot; echo "nh=$(ue_nh)" ) )"
  assert_has "$s" 'nh=1' "verify failed after the reboot: needs_hands once [$s]"
}

test_ue_r4_g6_three_actions_an_hour_then_escalate_once() {
  local s; s="$( ( ue_rf; local i; for i in 1 2 3; do echo "$GUARDIAN_FAKE_NOW x:y" >>"$STATE_DIR/actions"; done; ue_tick; ue_tick; ue_summary; echo "boot=$(ue_n 'launchctl bootout') rl=$(events | grep -c heal_rate_limited)" ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=0 shutdowns=0 A=0 .*boot=0 rl=1' "G6: no relaunch, one heal_rate_limited escalation [$s]"
}

test_ue_r4_flag_zero_is_inert_for_the_recorder_signature() {
  local s; s="$( ( ue_rf CONST=0; ue_tick; ue_tick; echo "files=$(ue_state_files) ev=$(ev_ue) boot=$(ue_n 'launchctl bootout') log=$(n_log)" ) )"
  assert_has "$s" 'files=0 ev=0 boot=0 log=0' "flag 0 with a failed recorder: no state file, no event, no relaunch, no log read [$s]"
}

test_ue_r4_failed_recorder_keeps_the_episode_open() {
  local s; s="$( ( ue_rf FDE=on; ue_tick; ue_tick; echo "nh=$(ue_nh) r=$(cat "$STATE_DIR/usb-enum-r" | wc -c | tr -d ' ')" ) )"
  assert_has "$s" 'nh=1 r=[1-9]' "mic and engine are both present but the recorder is failed: the tick does not end the episode [$s]"
}

# ---- AMENDMENT 1 (fable 17:22): reboot pre-flight = FileVault off + autoLoginUser set + a fresh, safe fleet attestation. Unknown = NO. ----
test_ue_am1_each_preflight_item_false_or_unknown_blocks_with_the_exact_reason() {
  assert_has "$(ue_case_a FDE=on)" 'reboots=0 .*blocked=preflight_fv' "FileVault on"
  assert_has "$(ue_case_a FDE=unknown)" 'reboots=0 .*blocked=preflight_fv' "FileVault unknown"
  assert_has "$(ue_case_a AUTOL=0)" 'reboots=0 .*blocked=preflight_autologin' "no autoLoginUser"
  assert_has "$(ue_case_a ATT=none)" 'reboots=0 .*blocked=preflight_attest' "no attestation file"
  assert_has "$(ue_case ATT=none)" 'reboots=0 .*blocked=preflight_attest' "no attestation file, whole ladder in one tick"
  assert_has "$(ue_case ATT=fresh)" 'reboots=1' "control: all three pass"
}
test_ue_am1_stale_writable_symlink_or_future_attestation_blocks() {
  assert_has "$(ue_case_a ATT=stale)" 'reboots=0 .*blocked=preflight_attest' "older than 7 days"
  assert_has "$(ue_case_a ATT=writable)" 'reboots=0 .*blocked=preflight_attest' "world-writable"
  assert_has "$(ue_case_a ATT=groupw)" 'reboots=0 .*blocked=preflight_attest' "group-writable"
  assert_has "$(ue_case_a ATT=symlink)" 'reboots=0 .*blocked=preflight_attest' "a symlink"
  assert_has "$(ue_case_a ATT=future)" 'reboots=0 .*blocked=preflight_attest' "dated in the future"
}
test_ue_am1_attestation_age_edge_is_7_days() {
  local s; s="$( ( ue_setup; touch -d "@$((GUARDIAN_FAKE_NOW - 604800))" "$FLAG_DIR/reboot-attested"; usb_enum_attested && echo in6 || echo out6; touch -d "@$((GUARDIAN_FAKE_NOW - 604801))" "$FLAG_DIR/reboot-attested"; usb_enum_attested && echo in7 || echo out7 ) | tr '\n' ' ')"
  assert_has "$s" 'in6 out7' "exactly 7 d is fine, 7 d + 1 s is stale [$s]"
}
test_ue_am1_needs_hands_once_per_episode_names_the_failing_item() {
  local s; s="$( ( ue_rf ATT=none; ue_tick; ue_tick; ue_tick; echo "nh=$(ue_nh)"; events | grep -o 'reason=preflight_attest' | head -1 ) | tr '\n' ' ')"
  assert_has "$s" 'nh=1 reason=preflight_attest' "once per episode, exact item [$s]"
}
test_ue_am1_the_attestation_is_rechecked_right_before_the_reboot() {
  local s; s="$( ( ue_setup
    eval "$(declare -f usb_enum_preflight | sed '1s/^usb_enum_preflight/orig_preflight/')"
    usb_enum_preflight() { local n; n="$(cat "$T/pfn" 2>/dev/null || echo 0)"; echo $((n + 1)) >"$T/pfn"; if [ "$n" -ge 1 ]; then rm -f "$FLAG_DIR/reboot-attested"; fi; orig_preflight; }
    ue_tick; ue_summary; events | grep -o 'aborted_preflight_[a-z]*' ) | tr '\n' ' ')"
  assert_has "$s" 'reboots=0 .*aborted_preflight_attest' "the file vanishes after the first check: abort with the exact reason [$s]"
}
test_ue_am1_guardian_never_touches_login_credentials_or_the_attestation() {
  local h="$KDIR/lib/heal.sh"
  assert_eq "$(grep -v '^[[:space:]]*#' "$h" | grep -c 'kcpassword\|authonly')" "0" "no credential read or test"
  assert_eq "$(grep -v '^[[:space:]]*#' "$h" | grep -c '>[[:space:]]*"\?\$FLAG_DIR/reboot-attested')" "0" "never writes the attestation"
}


# ---- R5: REAL captures (24 Oct 2026, tests/fixtures/real/). Trimmed from the kiosks' own ioreg / log / tapewriter output; formatting and wording untouched. ----
RF="$KDIR/tests/fixtures/real"
ue_epoch() { date -j -f '%Y-%m-%d %H:%M:%S' "$1" +%s 2>/dev/null || date -d "$1" +%s; }

# (a) OPD 4: the real IOUSB plane. The built-in pair on controller 02 is empty; the 2.4G dongle hangs off controller 01; no webcam anywhere.
test_ue_r5_real_hub_shape_is_the_mac_minis_builtin_pair_empty_on_every_kiosk() {
  ue_setup
  local k
  cp "$RF/opd4_iousb.txt" "$T/iousb.txt"
  usb_enum_ioreg_emptyhub 02; assert_rc "$?" 0 "OPD 4 real ioreg: USB3 Gen2 Hub@02200000 + USB2 Hub@02100000, both empty: hub evidence for a mic last seen on controller 02"
  usb_enum_ioreg_emptyhub 01; assert_rc "$?" 1 "...but not for a mic last seen on controller 01 (the dongle's controller)"
  usb_enum_ioreg_emptyhub ""; assert_rc "$?" 1 "...and not without a stamped location"
  for k in cardiology thirdfloor opd3; do
    cp "$RF/${k}_iousb.txt" "$T/iousb.txt"
    usb_enum_ioreg_emptyhub 02; assert_rc "$?" 0 "$k (a HEALTHY kiosk): the very same empty built-in pair, so the parser alone cannot tell a fault: that is why the controller prefix gates it"
    usb_enum_ioreg_emptyhub 03; assert_rc "$?" 1 "$k: a mic on another controller than the hub pair is no hub evidence"
  done
}
test_ue_r5_real_mic_location_is_8_hex_digits_in_the_node_name() {
  ue_setup
  cp "$RF/cardiology_iousb.txt" "$T/usb.txt"; USB_MIC_PATTERN=TONOR
  assert_eq "$(usb_enum_loc_now)" "03100000" "TONOR TM20 Audio Device@03100000"
  cp "$RF/opd3_iousb.txt" "$T/usb.txt"
  assert_eq "$(usb_enum_loc_now)" "00100000" "OPD 3: TONOR on controller 00"
}
# the ladder-level OPD 4 answer: last seen on the hub's controller (02), now absent
test_ue_r5_real_opd4_absent_with_stamped_hub_controller_reboots_otherwise_unplugged() {
  local s
  s="$( ( export EVID=none; ue_setup; cp "$RF/opd4_iousb.txt" "$T/iousb.txt"; printf '02110000\n' >"$USB_ENUM_LOC"; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=1 shutdowns=1 A=1' "mic last seen behind the 02 pair, pair empty now: rung A then one reboot [$s]"
  s="$( ( export EVID=none; ue_setup; cp "$RF/opd4_iousb.txt" "$T/iousb.txt"; printf '01110000\n' >"$USB_ENUM_LOC"; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*room_device_unplugged' "mic last seen on controller 01: the empty built-in pair says nothing: unplugged, no reboot [$s]"
  s="$( ( export EVID=none; ue_setup; cp "$RF/opd4_iousb.txt" "$T/iousb.txt"; ue_tick; ue_summary ) )"
  assert_has "$s" 'reboots=0 .*room_device_unplugged' "never stamped: unplugged, no reboot [$s]"
}

# (b) + (c): Cardiology 16:00:49 TONOR loss, the C270 cascade, the iPhone plugged into the same port 6 s later, unplugged at 16:09:44.
ue_card_case() { # sed_script window_start_hms
  ( export USB_MIC_PATTERN=TONOR; ue_setup; sed -n "$1" "$RF/cardiology_kernel_1600.txt" >"$T/log.txt"
    usb_enum_log_evidence "$(ue_epoch "2026-10-24 $2")" && echo yes || echo no )
}
test_ue_r5_real_cardiology_tonor_loss_names_the_mic() {
  assert_eq "$(ue_card_case '1,2p' 16:00:00)" yes "the loss line alone (real wording, mic-named, window includes it): kernel evidence"
  assert_eq "$(ue_card_case '1,2p' 16:00:50)" no "window opened after the line: no evidence"
  assert_eq "$(ue_card_case '2,3p' 16:00:00)" no "only AppleUSBIORequest errors of the mic, no loss line: not the log rule"
  assert_eq "$(ue_card_case '3,18p' 16:00:00)" no "the C270 cascade and coreaudiod lines never name the TONOR as lost"
}
test_ue_r5_real_iphone_plug_and_unplug_never_matches_the_mic_rule() {
  assert_eq "$(ue_card_case '10,$p' 16:00:00)" no "iPhone enumerate / exclusive-open errors / unplug at 16:09:44 (mic pattern TONOR): no evidence"
  assert_eq "$( ( export USB_MIC_PATTERN=C270; ue_setup; sed -n '10,$p' "$RF/cardiology_kernel_1600.txt" >"$T/log.txt"; usb_enum_log_evidence "$(ue_epoch '2026-10-24 16:00:00')" && echo yes || echo no ) )" no "same with the webcam pattern"
}
test_ue_r5_real_tonor_loss_followed_by_another_device_on_the_same_port_is_a_hand_swap() {
  assert_eq "$(ue_card_case '1,$p' 16:00:00)" no "TONOR lost at 16:00:49, an iPhone enumerates on usb-drd3-port-hs@03100000 at 16:00:55: someone swapped the plug, not an enumeration fault: NO evidence"
  assert_eq "$(ue_card_case '1,2p;3,$s/iPhone/TONOR TM20/p' 16:00:00)" yes "control: the same lines with the 'other' device being the mic itself: still evidence"
}
# rec_failed's own bus-event evidence must name the mic too
test_ue_r5_real_usbio_evidence_needs_the_mic_named() {
  local s
  s="$( ( export USB_MIC_PATTERN=TONOR; ue_rf; sed -n '10,$p' "$RF/cardiology_kernel_1600.txt" >"$T/log.txt"; GUARDIAN_FAKE_NOW="$(ue_epoch '2026-10-24 16:09:50')"; export GUARDIAN_FAKE_NOW
    usb_enum_usbio_cached "$(ue_epoch '2026-10-24 16:09:44')" && echo yes || echo no ) )"
  assert_eq "$s" no "an iPhone's AppleUSBIORequest errors at the episode start are not the mic's"
  s="$( ( export USB_MIC_PATTERN=TONOR; ue_rf; sed -n '1,3p' "$RF/cardiology_kernel_1600.txt" >"$T/log.txt"; GUARDIAN_FAKE_NOW="$(ue_epoch '2026-10-24 16:00:50')"; export GUARDIAN_FAKE_NOW
    usb_enum_usbio_cached "$(ue_epoch '2026-10-24 16:00:49')" && echo yes || echo no ) )"
  assert_eq "$s" yes "the TONOR's own errors within +-60 s: evidence"
}

# (d) Third Floor + OPD 3: the recorder's real last_error is "tapewriter exited with status 1"; the IOKit code and physical_fallback_required are only in tapewriter.log.
ue_collect() { write_status state=failed err="$UE_ERR"; collect_all; }
ue_tw_place() { # fixture [age_minutes]
  local d="$RR_ROOT/captures/bs_real/seg_real"; mkdir -p "$d"; cp "$1" "$d/tapewriter.log"
  [ -z "${2:-}" ] || touch -d "@$(( $(date +%s) - $2 * 60 ))" "$d/tapewriter.log"
}
test_ue_r5_real_tapewriter_failure_triggers_and_the_log_carries_the_code() {
  local k s
  for k in thirdfloor opd3; do
    s="$( ( ue_rf UE_ERR='tapewriter exited with status 1'; ue_tw_place "$RF/${k}_tapewriter_failed.txt"; ue_collect; usb_enum_rec_trigger && echo trig; usb_enum_rec_ioret && echo ioret ) | tr '\n' ' ')"
    assert_eq "$s" "trig ioret " "$k: real last_error triggers rec_failed; the IOKit code is found in the segment's tapewriter.log"
    s="$( ( ue_rf UE_ERR='tapewriter exited with status 1'; ue_tw_place "$RF/${k}_tapewriter_healthy.txt"; ue_collect; usb_enum_rec_trigger && echo trig; usb_enum_rec_ioret && echo ioret ) | tr '\n' ' ')"
    assert_eq "$s" "trig " "$k: a healthy tapewriter.log (micmode lines only) carries no code"
    s="$( ( ue_rf UE_ERR='tapewriter exited with status 1'; ue_tw_place "$RF/${k}_tapewriter_failed.txt" 60; usb_enum_rec_ioret && echo ioret ) | tr '\n' ' ')"
    assert_eq "$s" "" "$k: a stale (60 min old) failed log is not evidence"
    s="$( ( ue_rf UE_ERR='tapewriter exited with status 1' CONST=0; ue_tw_place "$RF/${k}_tapewriter_failed.txt"; usb_enum_rec_ioret && echo ioret ) | tr '\n' ' ')"
    assert_eq "$s" "" "$k: flag 0 never reads the log"
  done
  rm -rf "$RR_ROOT/captures/bs_real"   # the loop above left its fixture in the shared sandbox
  # the real log lines, as last_error text, still work for a recorder that copies them
  s="$( ( ue_rf UE_ERR="$(sed -n '4p' "$RF/thirdfloor_tapewriter_failed.txt")"; ue_collect; usb_enum_rec_ioret && echo ioret; usb_enum_rec_trigger && echo trig ) | tr '\n' ' ')"
  assert_eq "$s" "ioret trig " "the real 'Audio acquisition cycle 1 failed ... error -536870163.)' line"
  s="$( ( ue_rf UE_ERR="$(grep physical_fallback "$RF/opd3_tapewriter_failed.txt")"; ue_collect; usb_enum_rec_trigger && echo trig; usb_enum_rec_ioret && echo ioret ) | tr '\n' ' ')"
  assert_eq "$s" "trig " "the real 'tapewriter: physical_fallback_required: ...' line triggers; it carries no IOKit code, so it is not evidence by itself"
}
test_ue_r5_real_tapewriter_failure_reaches_the_ladder_with_the_log_as_evidence() {
  local s k
  for k in thirdfloor opd3; do
    s="$( ( ue_rf UE_ERR='tapewriter exited with status 1'; ue_tw_place "$RF/${k}_tapewriter_failed.txt"; ue_tick; ue_summary; echo "boot=$(ue_n 'launchctl bootout') nh=$(ue_nh)" ) | tr '\n' ' ')"
    assert_has "$s" 'boot=1' "$k: rung R relaunch runs [$s]"
    assert_has "$s" 'reboots=1' "$k: relaunch did not cure it, the log's IOKit code is evidence: rung A then rung B [$s]"
    s="$( ( ue_rf UE_ERR='tapewriter exited with status 1'; ue_tw_place "$RF/${k}_tapewriter_healthy.txt"; ue_tick; ue_summary; echo "nh=$(ue_nh)" ) | tr '\n' ' ')"
    assert_has "$s" 'reboots=0 .*blocked=no_enum_evidence.*nh=1' "$k: without the code anywhere: needs_hands, never a reboot [$s]"
  done
}
