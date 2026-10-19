#!/bin/bash
# R15c: a TCC row the helper could not read (error, error:read, error:bad_user, error:<why>) is UNKNOWN: no tcc verdict, l59 stays 0, no heal, no page.
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154

r15c_fake_helper() { # <row output> : a helper whose tcc-row prints $1; every call is logged
  cat >"$T/fakehelper" <<F
#!/bin/bash
echo "helper \$*" >>"$CALLS"
case "\$1" in tcc-row) echo '$1'; exit 0 ;; esac
exit 0
F
  chmod +x "$T/fakehelper"; export GUARDIAN_ROOT_HELPER="$T/fakehelper"
}
r15c_audit_count() { local n; n="$(grep -c 'tcc row unreadable' "$GUARDIAN_HOME/audit.log" 2>/dev/null)"; echo "${n:-0}"; }

test_r15c_unreadable_row_is_unknown() {
  local v i
  for v in error:read error:bad_user error error:whatever; do
    load_libs; rm -rf "$STATE_DIR"/once "$STATE_DIR/tcc_row"; : >"$GUARDIAN_HOME/audit.log"
    r15c_fake_helper "$v"; write_status mic_state=authorized; : >"$T/engine.txt"
    collect_all
    assert_eq "$S_tcc_row" "$v" "$v: collect keeps the full token"
    assert_eq "$(fault_tree | cut -d'|' -f2 | tr '\n' ' ')" "coreaudio_no_device " "$v: no tcc verdict; the CoreAudio verdict is NOT held"
    for i in 1 2 3 4 5 6 7 8 9; do fault_tree >/dev/null; done
    assert_eq "$(r15c_audit_count)" "1" "$v: one audit line over 10 ticks"
    assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "tcc row unreadable: $v" "$v: audit text"
  done
}

test_r15c_regression_rows() {
  load_libs; mk_tcc 0; write_status mic_state=authorized; collect_all
  assert_eq "$(fault_tree | cut -d'|' -f2 | tr '\n' ' ')" "mic_denied " "row 0 still mic_denied"
  rm -f "$STATE_DIR/tcc_row"; sqlite3 "$T/TCC.db" "DELETE FROM access WHERE client='com.evenscribe.room-recorder'"; collect_all
  assert_eq "$(fault_tree | cut -d'|' -f2 | tr '\n' ' ')" "mic_row_missing " "none still mic_row_missing"
  mk_tcc 2; collect_all
  assert_eq "$(fault_tree | cut -d'|' -f2 | tr '\n' ' ')" "" "row 2 no verdict"
  assert_eq "$(r15c_audit_count)" "0" "no unreadable audit line for readable rows"
}

test_r15c_recorder_denied_still_wins_with_unreadable_row() {
  load_libs; r15c_fake_helper error:read; write_status mic_state=denied state=mic_denied; collect_all
  assert_eq "$(fault_tree | cut -d'|' -f2 | tr '\n' ' ')" "mic_denied " "recorder-sourced denial unchanged"
}

test_r15c_heal_mode_end_to_end_no_heal() {
  load_libs; r15c_fake_helper error:read; write_status mic_state=authorized capture_open=false; touch "$T/boot_ok"; go_heal
  local i
  for i in 1 2 3 4; do collect_all; heal_cycle; done
  assert_not "$(cat "$CALLS")" "tcc-heal" "0 tcc-heal calls"
  assert_eq "$(events | wc -l | tr -d ' ')" "0" "0 heal events"
  assert_eq "$(r15c_audit_count)" "1" "one audit line over 4 cycles"
}
