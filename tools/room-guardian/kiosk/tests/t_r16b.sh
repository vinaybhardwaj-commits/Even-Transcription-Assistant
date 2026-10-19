#!/bin/bash
# R16b: R15c refute lead (only a number other than 2 is a denial), RC-4 (no tcc-heal rung while the row is unreadable), GR15-2 / GR15-10 (helper PATH pinned, subscribe exit code kept,
# Chrome day rule needs the consult hold clear). Needs t_r15c.sh's helpers (r15c_fake_helper, r15c_audit_count) and t_control.sh's start_loops.
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154

# ---- item 5: non-numeric, non-error text is UNKNOWN too ----
test_r16b_non_numeric_row_text_is_unknown_with_one_audit_line() {
  local v i
  for v in garbage x1 2x -1 'denied'; do
    load_libs; rm -rf "$STATE_DIR"/once "$STATE_DIR/tcc_row"; : >"$GUARDIAN_HOME/audit.log"
    r15c_fake_helper "$v"; write_status mic_state=authorized; collect_all
    assert_eq "$(fault_tree | cut -d'|' -f2 | tr '\n' ' ')" "" "$v: no verdict"
    for i in 1 2 3; do fault_tree >/dev/null; done
    assert_eq "$(r15c_audit_count)" "1" "$v: one audit line"
  done
  load_libs; rm -rf "$STATE_DIR"/once "$STATE_DIR/tcc_row"; r15c_fake_helper 1; write_status mic_state=authorized; collect_all
  assert_eq "$(fault_tree | cut -d'|' -f2 | tr '\n' ' ')" "mic_denied " "a number other than 2 still denies"
}

# ---- item 6: RC-4 ----
test_r16b_unreadable_row_skips_the_tcc_heal_rung_and_escalates_only() {
  load_libs; r15c_fake_helper error:read; write_status mic_state=denied state=mic_denied capture_open=false; touch "$T/boot_ok"; go_heal
  rm -f "$STATE_DIR/actions"; collect_all; heal_cycle
  assert_not "$(cat "$CALLS")" "tcc-heal" "no tcc-heal call while the row is unreadable"
  assert_eq "$(grep '^helper ' "$CALLS" | grep -v -c '^helper tcc-row ')" "0" "the only helper calls are tcc-row reads: no root call that writes"
  assert_has "$(events)" "escalate" "an escalate event instead"
  assert_eq "$(cat "$STATE_DIR/actions" 2>/dev/null | wc -l | tr -d ' ')" "0" "no hourly action spent"
}
test_r16b_readable_denied_row_still_runs_the_tcc_heal_rung() {
  load_libs; r15c_fake_helper 0; write_status mic_state=denied state=mic_denied capture_open=false; touch "$T/boot_ok"; go_heal
  rm -f "$STATE_DIR/actions"; collect_all; heal_cycle
  assert_has "$(cat "$CALLS")" "helper tcc-heal" "numeric row: the rung still runs"
}

# ---- item 7a: helper PATH pinned, tools by absolute path ----
test_r16b_helper_pins_path_first_and_ignores_a_planted_sqlite3() {
  local h="$KDIR/bin/guardian-root.sh" first out
  first="$(grep -v -E '^[[:space:]]*(#|$)' "$h" | head -n1)"
  assert_eq "$first" 'PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH' "PATH pin is the first statement"
  assert_eq "$(grep -v -E '^[[:space:]]*#' "$h" | grep -c -E '(^|[|;&{(] *|\$\( *|&& *)(stat|sqlite3|awk|cut|sort|rm|head|tail|killall|pmset|log) ')" "0" "no bare tool call"
  mk_tcc 2
  mkdir -p "$T/plant"; printf '#!/bin/bash\necho PLANTED >>"%s/plant.mark"\nexit 1\n' "$T" >"$T/plant/sqlite3"; chmod +x "$T/plant/sqlite3"; : >"$T/plant.mark"
  out="$(PATH="$T/plant:$PATH" /bin/bash -p "$h" tcc-row "$(id -un)" 2>&1)"
  assert_eq "$(wc -c <"$T/plant.mark" | tr -d ' ')" "0" "the planted sqlite3 never ran"
  assert_eq "$out" "2|$(sqlite3 "$T/TCC.db" "SELECT auth_reason||'|'||last_modified FROM access WHERE client='com.evenscribe.room-recorder'")" "the real answer came back"
}

# ---- item 7b: the subscribe command's exit code is not hidden by the pipeline ----
r16b_wait_audit() { local i=0; while [ "$i" -lt 60 ] && ! grep -q "$1" "$GUARDIAN_HOME/audit.log" 2>/dev/null; do sleep 0.25; i=$((i + 1)); done; }
test_r16b_subscribe_exit_code_reaches_the_audit_line() {
  load_libs; : >"$GUARDIAN_HOME/audit.log"
  export GUARDIAN_SUBSCRIBE_CMD='exit 7' GUARDIAN_CONTROL_SUB_CMD='exit 9'
  start_loops subscriber_loop control_loop
  r16b_wait_audit "control subscriber exited rc=9"; r16b_wait_audit "[^l] subscriber exited rc=7"
  kill "$LM" 2>/dev/null; wait "$LM" 2>/dev/null
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "subscriber exited rc=7" "subscribe ssh rc kept"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "control subscriber exited rc=9" "control ssh rc kept"
}

# ---- item 7c: Chrome day rule needs the consult hold clear ----
test_r16b_chrome_by_day_needs_the_consult_hold_clear() {
  load_libs; mk_tcc 2; write_status capture_open=false; echo 3600000000000 >"$T/hid"; go_heal; collect_all
  chrome_restart_allowed; assert_rc $? 1 "idle and quiet, but no control signal: defer"
  consult_clear; chrome_restart_allowed; assert_rc $? 0 "consult_open false for this room: allowed"
  printf '%s\n{"consult_open": {"opd9": true}, "kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"
  chrome_restart_allowed; assert_rc $? 1 "consult_open true: defer"
  consult_clear 600; chrome_restart_allowed; assert_rc $? 1 "stale signal: defer"
  printf '%s\n{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$((GUARDIAN_FAKE_NOW - 1))" "$GUARDIAN_FAKE_NOW" >"$STATE_DIR/control.last"
  chrome_restart_allowed; assert_rc $? 1 "old-form payload (no consult_open): defer"
  printf 'garbage\n' >"$STATE_DIR/control.last"
  chrome_restart_allowed; assert_rc $? 1 "garbage: defer"
}
test_r16b_chrome_at_night_does_not_need_the_signal() {
  load_libs; mk_tcc 2; write_status capture_open=false; go_heal; collect_all
  GUARDIAN_FAKE_NOW="$(ist_epoch 23:00)"; export GUARDIAN_FAKE_NOW
  rm -f "$STATE_DIR/control.last"
  chrome_restart_allowed; assert_rc $? 0 "night window, no signal: allowed"
}
