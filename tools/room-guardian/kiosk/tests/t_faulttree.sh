#!/bin/bash
# Fault tree (spec 2.3): order, stacking, held CoreAudio verdict.
ft() { collect_all; fault_tree | cut -d'|' -f2 | tr '\n' ' '; }

test_healthy_room_has_no_faults() { load_libs; mk_tcc 2; assert_eq "$(ft)" "" "no faults"; }

test_stacked_opd4_faults_in_order() {
  load_libs; mk_tcc 0
  : >"$T/usb.txt"; : >"$T/engine.txt"
  write_status state=retired mic_state=denied
  assert_eq "$(ft)" "usb_device_missing mic_denied server_retired " "OPD 4 stack: device, permission, retired"
}

test_coreaudio_held_until_5_to_9_clear() {
  load_libs; mk_tcc 2; : >"$T/engine.txt"
  assert_eq "$(ft)" "coreaudio_no_device " "emitted when nothing else is wrong"
  mk_tcc 0
  assert_eq "$(ft)" "mic_denied " "held back while permission is the fault"
}

test_each_layer_verdict() {
  load_libs; mk_tcc 2
  write_status state=needs_enrol;       assert_eq "$(ft)" "recorder_needs_enrol " "needs_enrol"
  write_status helper=false;            assert_eq "$(ft)" "helper_xpc_down " "helper"
  write_status poll_age=900;            assert_eq "$(ft)" "recorder_hung " "hung (alive, no poll)"
  write_status state=offline;           assert_eq "$(ft)" "network_offline " "offline"
  write_status mic_state=restricted;    assert_eq "$(ft)" "mic_restricted " "restricted"
  write_status state=capture_stalled;   assert_eq "$(ft)" "recorder_capture_stalled " "stalled"
  write_status; : >"$T/rec_pid";        assert_eq "$(ft)" "recorder_not_running " "no pid"
  echo 4242 >"$T/rec_pid"
  mk_tcc 0; write_status;               assert_eq "$(ft)" "mic_denied " "row flipped, recorder still says authorized"
  sqlite3 "$T/TCC.db" "DELETE FROM access WHERE client='com.evenscribe.room-recorder'"; rm -f "$STATE_DIR/tcc_row"
  assert_eq "$(ft)" "mic_row_missing " "row absent"
}

test_presence_stale_and_drift() {
  load_libs; mk_tcc 2
  export PRESENCE_FILE="$T/pres"; : >"$PRESENCE_FILE"; touch -t 202610140000 "$PRESENCE_FILE"
  assert_eq "$(ft)" "presence_stale " "presence"
  rm -f "$PRESENCE_FILE"; unset PRESENCE_FILE
  printf 'sleep 10\nautorestart 0\n' >"$T/pmset"
  assert_eq "$(ft)" "pmset_drift " "pmset drift"
  printf 'sleep 0\nautorestart 1\n' >"$T/pmset"; : >/dev/null; rm -f "$RR_PLIST"
  assert_eq "$(ft)" "launchagent_missing " "plist missing"
}

test_crash_loop_from_pid_changes() {
  load_libs; mk_tcc 2
  local n; n="$GUARDIAN_FAKE_NOW"
  printf '%s 1\n%s 2\n%s 3\n' $((n - 300)) $((n - 200)) $((n - 100)) >"$STATE_DIR/rec_pids"
  assert_eq "$(ft)" "recorder_crash_loop " "3 pid changes in an hour"
}
