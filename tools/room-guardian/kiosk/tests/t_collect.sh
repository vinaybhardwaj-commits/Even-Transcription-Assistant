#!/bin/bash
# Health stream (spec 2.1) and parsing helpers.
test_json_and_time_helpers() {
  load_libs
  printf '{"a":"x y","n":12,"b":true,"z":null}\n' >"$T/j.json"
  assert_eq "$(json_get "$T/j.json" a)" "x y" "string"
  assert_eq "$(json_get "$T/j.json" n)" "12" "number"
  assert_eq "$(json_get "$T/j.json" b)" "true" "bool"
  assert_eq "$(json_get "$T/j.json" z)" "" "null is empty"
  assert_eq "$(json_get "$T/j.json" nope)" "" "missing"
  assert_eq "$(ts_to_epoch 1700000000)" "1700000000" "epoch s"
  assert_eq "$(ts_to_epoch 1700000000123)" "1700000000" "epoch ms"
  assert_eq "$(ts_to_epoch 2023-11-14T22:13:20Z)" "1700000000" "iso"
  assert_eq "$(etime_to_s 01:00)" "60" "etime mm:ss"
  assert_eq "$(etime_to_s 2-01:00:05)" "176405" "etime dd-hh:mm:ss"
  assert_eq "$(ist_hhmm "$(ist_epoch 21:35)")" "2135" "ist"
}

test_rms_pinned_both_directions() {
  load_libs
  mk_pcm 16384 3; assert_eq "$(rms_dbfs_2s)" "-6.0" "half scale is -6.0 dBFS"
  mk_pcm 3277 3;  assert_eq "$(rms_dbfs_2s)" "-20.0" "0.1 scale is -20.0 dBFS"
  mk_pcm 0 3;     assert_eq "$(rms_dbfs_2s)" "-120.0" "digital zero is -120"
  touch -t 202601010000 "$RR_ROOT/captures/c1/seg_001/tape.pcm"
  assert_eq "$(rms_dbfs_2s)" "" "stale tape.pcm gives no reading, never a second capture"
  rm -rf "$RR_ROOT/captures"; mkdir -p "$RR_ROOT/captures"
  assert_eq "$(rms_dbfs_2s)" "" "no capture gives no reading"
}

test_health_line_fields() {
  load_libs; mk_pcm 16384 3; mk_tcc 2; go_shadow
  collect_all
  local h; h="$(health_line)"
  for k in room_id install_id ts state mic_state capture_open pending_piece_count rms_dbfs_2s usb_mic_present audio_engine_present coreaudiod_age_s recorder_pid_age_s helper_xpc_ok last_poll_ok_age_s last_http disk_free_pct_root disk_free_pct_home boot_age_s presence_heartbeat_age_s; do
    assert_has "$h" "\"$k\":" "field $k"
  done
  assert_has "$h" '"rms_dbfs_2s":-6.0' "rms value"
  assert_has "$h" '"usb_mic_present":true' "usb"
  assert_has "$h" '"last_poll_ok_age_s":5' "poll age"
  assert_has "$h" '"disk_free_pct_root":60' "disk"
  assert_has "$h" '"recorder_pid_age_s":60' "pid age"
  assert_has "$h" '"boot_age_s":100000' "boot age"
  assert_has "$h" '"presence_heartbeat_age_s":null' "presence null when unreadable"
  assert_has "$h" '"mode":"shadow"' "mode"
}

test_g9_no_free_text_leaks() {
  load_libs; mk_tcc 2; go_heal
  write_status 'err=SECRETTEXT room_disabled' 'extra=,"note_text":"SECRETTEXT","patient_label":"SECRETTEXT"'
  guardian_once() { bash "$KDIR/bin/guardian.sh" once; }
  GUARDIAN_CONF=/dev/null guardian_once
  assert_not "$(cat "$T/pub.log")" SECRETTEXT "nothing free-text on the pipe"
  assert_not "$(cat "$GUARDIAN_HOME/audit.log" 2>/dev/null)" SECRETTEXT "nothing free-text in audit"
  assert_has "$(cat "$T/pub.log")" "server_disabled" "disabled still detected from last_error"
}

test_tick_publishes_health_once_per_tick() {
  load_libs; mk_tcc 2
  GUARDIAN_CONF=/dev/null bash "$KDIR/bin/guardian.sh" once
  assert_eq "$(grep -c "kiosk/opd9/health" "$T/pub.log")" "1" "one health line"
  assert_eq "$(events | wc -l | tr -d ' ')" "0" "healthy room: no heal events"
}
