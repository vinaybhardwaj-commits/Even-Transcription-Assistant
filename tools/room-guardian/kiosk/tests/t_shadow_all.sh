#!/bin/bash
# C3 (R2): every dispatcher action is report-only in SHADOW, with no control, with stale control and with kill=true.
# HEAL mode (fresh kill=false, this room = heal) is the positive control: each action path is reached.
# same helper as t_control.sh (control.last as the control loop writes it, received $1 s ago)
put_ctl() {
  mkdir -p "$STATE_DIR"
  { printf "%s\n" "$((GUARDIAN_FAKE_NOW - $1))"; printf "%s\n" "$2"; } >"$STATE_DIR/control.last"
}
SA_HEAL='{"kill": false, "modes": {"opd9": "heal"}, "ts": 0}'
SA_SHADOW='{"kill": false, "modes": {"opd9": "shadow"}, "ts": 0}'
SA_KILL='{"kill": true, "modes": {"opd9": "heal"}, "ts": 0}'
MUTATING='launchctl boot(out|strap)|^killall|^pkill|^open |tcc-heal|coreaudiod-kill|pmset-baseline|tcc-prune|install-launch-agent|^afplay |guardian-root.sh reboot|^SHUTDOWN'

# sa_ctl <shadow|oldflag|none|stale|kill|heal>
sa_ctl() {
  local m="$1" p
  rm -f "$STATE_DIR/control.last" "$STATE_DIR/control_latch" "$STATE_DIR/control_state" "$STATE_DIR/flags.cache"
  rm -rf "$STATE_DIR/once"; rm -f "$STATE_DIR/actions" "$STATE_DIR/flag_last"
  export GUARDIAN_CONTROL_SUB_CMD='true'
  if [ "${SA_CLEAR:-}" = 1 ]; then SA_HEAL='{"consult_open": {"opd9": false}, "kill": false, "modes": {"opd9": "heal"}, "ts": 0}'; SA_SHADOW='{"consult_open": {"opd9": false}, "kill": false, "modes": {"opd9": "shadow"}, "ts": 0}'; SA_KILL='{"consult_open": {"opd9": false}, "kill": true, "modes": {"opd9": "heal"}, "ts": 0}'
  else SA_HEAL='{"kill": false, "modes": {"opd9": "heal"}, "ts": 0}'; SA_SHADOW='{"kill": false, "modes": {"opd9": "shadow"}, "ts": 0}'; SA_KILL='{"kill": true, "modes": {"opd9": "heal"}, "ts": 0}'; fi
  case "$m" in
    oldflag) export GUARDIAN_CONTROL_SUB_CMD=""; go_shadow; return ;;
    none) ;;
    shadow) p="${SA_SHADOW/\"ts\": 0/\"ts\": $GUARDIAN_FAKE_NOW}"; put_ctl 1 "$p" ;;
    stale)  p="${SA_HEAL/\"ts\": 0/\"ts\": $((GUARDIAN_FAKE_NOW - 91))}"; put_ctl 91 "$p" ;;
    kill)   p="${SA_KILL/\"ts\": 0/\"ts\": $GUARDIAN_FAKE_NOW}"; put_ctl 1 "$p" ;;
    heal)   p="${SA_HEAL/\"ts\": 0/\"ts\": $GUARDIAN_FAKE_NOW}"; put_ctl 1 "$p" ;;
  esac
  flag_fetch
}

# sa_prep <action>: fixture for one action; sets SA_CALL (the function line) and SA_POS (call text proving the path ran in HEAL)
sa_prep() {
  : >"$CALLS"; : >"$T/pub.log"; rm -f "$RR_PLIST.gone"
  GUARDIAN_FAKE_NOW="$(ist_epoch 11:00)"; : >"$RR_PLIST"
  printf 'sleep 0\nautorestart 1\n' >"$T/pmset"; echo 4242 >"$T/rec_pid"; printf 'USB Audio C270 HD\n' >"$T/usb.txt"; printf 'C270 engine\n' >"$T/engine.txt"
  SA_CLEAR=0; rm -f "$STATE_DIR"/usb_absent "$STATE_DIR"/cc_probe.neg "$STATE_DIR"/usb-reboot "$STATE_DIR"/usb-reboot.tmp "$STATE_DIR"/usb-reboot-lock; USB_REBOOT_ISSUED=0
  mk_tcc 2; write_status capture_open=false; touch "$T/boot_ok"
  case "$1" in
    tcc) mk_tcc 0; write_status mic_state=denied capture_open=false state=mic_denied; SA_CALL="heal_tcc"; SA_POS="tcc-heal" ;;
    coreaudiod) : >"$T/engine.txt"; SA_CALL="heal_coreaudiod"; SA_POS="coreaudiod-kill" ;;
    rec_dead) : >"$T/rec_pid"; SA_CALL="heal_recorder recorder_not_running"; SA_POS="launchctl bootout" ;;
    rec_hung) write_status capture_open=false poll_age=900; SA_CALL="heal_recorder recorder_hung"; SA_POS="launchctl bootout" ;;
    rec_enrol) write_status state=needs_enrol capture_open=false; SA_CALL="heal_recorder recorder_needs_enrol"; SA_POS="launchctl bootout" ;;
    chrome) GUARDIAN_FAKE_NOW="$(ist_epoch 23:00)"; write_status capture_open=false; SA_CALL="heal_chrome"; SA_POS="pkill -x Google Chrome" ;;
    pmset) printf 'sleep 10\nautorestart 0\n' >"$T/pmset"; SA_CALL="heal_drift pmset_drift"; SA_POS="pmset-baseline" ;;
    la_missing) rm -f "$RR_PLIST"; SA_CALL="heal_drift launchagent_missing"; SA_POS="install-launch-agent" ;;
    canary) GUARDIAN_FAKE_NOW="$(ist_epoch 23:00)"; write_status capture_open=false; mk_pcm 100 10; rm -f "$STATE_DIR/canary_night"; SA_CALL="canary_cycle"; SA_POS="afplay" ;;
    usb) SA_CLEAR=1; : >"$T/usb.txt"; : >"$T/engine.txt"; echo 1000000000000 >"$T/hid"
         { printf 'header\n'; printf '%s.104 Df  kernel[0:694] [com.apple.usb:all] usb-drd3-port-hs@03100000: AppleUSBHostPort::cableChangeOccurred: powering off\n' "$(date -r "$((GUARDIAN_FAKE_NOW - 60))" '+%Y-%m-%d %H:%M:%S')"; } >"$T/log.txt"
         printf '2 %s\n' "$((GUARDIAN_FAKE_NOW - 10))" >"$STATE_DIR/usb_absent"; SA_CALL="heal_usb_power_off x"; SA_POS="guardian-root.sh reboot" ;;
    cycle) GUARDIAN_FAKE_NOW="$(ist_epoch 23:00)"; mk_tcc 0; write_status mic_state=denied capture_open=false state=mic_denied
           printf 'sleep 10\nautorestart 0\n' >"$T/pmset"; rm -f "$RR_PLIST"; : >"$T/usb.txt"
           SA_CALL="heal_cycle"; SA_POS="tcc-heal" ;;
  esac
  export PRESENCE_FILE="$T/pres"; : >"$PRESENCE_FILE"; touch -t 202610140000 "$PRESENCE_FILE"
}

test_every_action_is_report_only_unless_heal() {
  load_libs; export CONFIRM_TIMEOUT_S=1
  local a m row0 row1 n=0
  for a in tcc coreaudiod rec_dead rec_hung rec_enrol chrome pmset la_missing cycle canary usb; do
    for m in shadow oldflag none stale kill; do
      sa_prep "$a"; sa_ctl "$m"
      [ "$a" = tcc ] || [ "$a" = cycle ] && row0="$(tcc_val)"
      collect_all
      $SA_CALL >/dev/null 2>&1
      n=$((n + 1))
      assert_not "$(grep -E "$MUTATING" "$CALLS")" "." "$a/$m: no mutating call"
      if [ "$a" = tcc ] || [ "$a" = cycle ]; then row1="$(tcc_val)"; assert_eq "$row1" "$row0" "$a/$m: TCC row unchanged"; fi
      assert_has "$(events)" 'WOULD-DO' "$a/$m: WOULD-DO reported"
    done
  done
  assert_eq "$n" "55" "all 55 cases ran"
}

test_heal_mode_reaches_every_action_path() {
  load_libs; export CONFIRM_TIMEOUT_S=1
  local a
  for a in tcc coreaudiod rec_dead rec_hung rec_enrol chrome pmset la_missing cycle canary usb; do
    sa_prep "$a"; sa_ctl heal; collect_all
    $SA_CALL >/dev/null 2>&1
    assert_has "$(cat "$CALLS")" "$SA_POS" "$a: HEAL reaches the action"
  done
}

test_act_step_refuses_in_shadow() {
  load_libs
  local m
  for m in shadow oldflag; do
    sa_prep rec_dead; sa_ctl "$m"; collect_all
    recorder_restart
    assert_not "$(cat "$CALLS")" "launchctl boot" "$m: direct recorder_restart in SHADOW does nothing"
    act_step; assert_rc $? 1 "$m: act_step refuses in shadow"
  done
  sa_prep rec_dead; sa_ctl heal; collect_all
  act_step; assert_rc $? 0 "act_step allows heal"
  recorder_restart; assert_has "$(cat "$CALLS")" "launchctl bootout" "heal: restart runs"
}
