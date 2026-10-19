#!/bin/bash
# R16c: R16b refute S1 (test seams never trust $EUID), S4 (heal_tcc only on a numeric row).
# Needs t_r15.sh's r15_pre and t_r15c.sh's r15c_fake_helper.
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154

# ---- S1: the seams read the real uid (/usr/bin/id -u), never $EUID ----
# The helper copy under test has its one `/usr/bin/id` path swapped for a fake that prints $1. There is no id seam in the shipped helper.
r16c_helper_with_id() { # <id output> : prints the path of a helper copy whose id prints $1
  printf '#!/bin/bash\nprintf "%%s\\n" "%s"\n' "$1" >"$T/fakeid"; chmod +x "$T/fakeid"
  /usr/bin/sed "s#/usr/bin/id -u#$T/fakeid -u#" "$KDIR/bin/guardian-root.sh" >"$T/h_id.sh"; chmod +x "$T/h_id.sh"; printf '%s' "$T/h_id.sh"
}
r16c_seam_marks() { # <helper> : run all three seams, print the marks that fired
  local h="$1"
  mk_tcc 1
  printf '#!/bin/bash\necho FAKESD >>"%s/seam.mark"\n' "$T" >"$T/bin/fakeshutdown"; printf '#!/bin/bash\necho FAKELOG >>"%s/seam.mark"\n' "$T" >"$T/bin/log"; chmod +x "$T/bin/fakeshutdown" "$T/bin/log"
  : >"$T/seam.mark"
  /usr/bin/env -i PATH=/usr/bin:/bin EUID="$R16C_EUID" GUARDIAN_ROOT_TESTMODE=1 GUARDIAN_ROOT_TEST_DB="$T/TCC.db" GUARDIAN_SHUTDOWN_BIN="$T/bin/fakeshutdown" GUARDIAN_ROOT_LOG_BIN="$T/bin/log" \
    /bin/bash -p "$h" reboot >/dev/null 2>&1
  /usr/bin/env -i PATH=/usr/bin:/bin EUID="$R16C_EUID" GUARDIAN_ROOT_TESTMODE=1 GUARDIAN_ROOT_TEST_DB="$T/TCC.db" GUARDIAN_SHUTDOWN_BIN="$T/bin/fakeshutdown" GUARDIAN_ROOT_LOG_BIN="$T/bin/log" \
    /bin/bash -p "$h" log-grab 1 >/dev/null 2>&1
  printf "%s" "$(/usr/bin/env -i PATH=/usr/bin:/bin EUID="$R16C_EUID" GUARDIAN_ROOT_TESTMODE=1 GUARDIAN_ROOT_TEST_DB="$T/TCC.db" /bin/bash -p "$h" tcc-row "$(id -un)" 2>&1)" >"$T/seam.row"
  tr '\n' ' ' <"$T/seam.mark"
}
test_r16c_non_root_keeps_the_seams_even_with_euid_zero_in_the_environment() {
  [ "$(id -u)" != 0 ] || { echo "  SKIP running as root"; return 0; }
  local m
  R16C_EUID=0; m="$(r16c_seam_marks "$KDIR/bin/guardian-root.sh")"
  assert_has "$m" "FAKESD" "EUID=0 in env, real uid not 0: the shutdown seam works"
  assert_has "$m" "FAKELOG" "EUID=0 in env, real uid not 0: the log seam works"
  assert_has "$(cat "$T/seam.row")" "1|4|1000" "EUID=0 in env, real uid not 0: the db seam works"
}
test_r16c_a_root_id_refuses_all_three_seams_even_with_euid_501_in_the_environment() {
  local h m
  R16C_EUID=501; h="$(r16c_helper_with_id 501)"
  m="$(r16c_seam_marks "$h")"
  assert_has "$m" "FAKESD" "control: id 501 + EUID=501: the shutdown seam works"
  assert_has "$(cat "$T/seam.row")" "1|4|1000" "control: id 501: the db seam works"
  for i in 0 ""; do
    h="$(r16c_helper_with_id "$i")"
    m="$(r16c_seam_marks "$h")"
    assert_eq "$m" "" "id prints [$i], EUID=501 in env: neither the shutdown nor the log seam ran"
    assert_not "$(cat "$T/seam.row")" "1|4|1000" "id prints [$i], EUID=501 in env: the db seam is refused"
  done
  h="$(r16c_helper_with_id garbage)"; m="$(r16c_seam_marks "$h")"
  assert_eq "$m" "" "id prints garbage: no seam (fail closed)"
  # id that fails outright
  printf '#!/bin/bash\nexit 1\n' >"$T/fakeid"; chmod +x "$T/fakeid"
  /usr/bin/sed "s#/usr/bin/id -u#$T/fakeid -u#" "$KDIR/bin/guardian-root.sh" >"$T/h_id.sh"
  m="$(r16c_seam_marks "$T/h_id.sh")"; assert_eq "$m" "" "id fails: no seam (fail closed)"
}
test_r16c_no_decision_in_bin_or_lib_reads_euid_or_uid() {
  assert_eq "$(grep -rn -v '^[[:space:]]*#' "$KDIR/bin" "$KDIR/lib" "$KDIR/install.sh" "$KDIR/uninstall.sh" | grep -c -E '\$\{?(EUID|UID)\b|\b(EUID|UID)=')" "0" "no \$EUID / \$UID in bin, lib, install, uninstall"
}

# ---- S2 lives in t_r15.sh (symlink ancestor: rc 3 + stderr "symlink:") ----

# ---- S4 ----
r16c_denied_run() { # <row text or "EMPTY"> : mic denied, the row is $1
  load_libs; rm -f "$STATE_DIR/tcc_row"
  r15c_fake_helper "$([ "$1" = EMPTY ] && echo 0 || echo "$1")"
  write_status mic_state=denied state=mic_denied capture_open=false; touch "$T/boot_ok"; go_heal
  rm -f "$STATE_DIR/actions"; : >"$CALLS"; collect_all
  [ "$1" = EMPTY ] && printf '%s\n\n' "$(now_epoch)" >"$STATE_DIR/tcc_row" && tcc_row_cached   # an empty cached row: S_tcc_row is ""
  heal_cycle
}
test_r16c_garbage_row_with_mic_denied_escalates_with_no_root_call() {
  local v
  for v in garbage x1 none error:read EMPTY; do
    r16c_denied_run "$v"
    assert_not "$(cat "$CALLS")" "tcc-heal" "[$v]: no tcc-heal call"
    assert_eq "$(grep '^helper ' "$CALLS" | grep -v -c '^helper tcc-row ')" "0" "[$v]: only tcc-row reads reached the helper"
    assert_has "$(events)" "escalate" "[$v]: an escalate event"
    assert_eq "$(cat "$STATE_DIR/actions" 2>/dev/null | wc -l | tr -d ' ')" "0" "[$v]: no hourly action spent"
  done
}
test_r16c_numeric_zero_row_with_mic_denied_still_runs_heal_tcc() {
  r16c_denied_run 0
  assert_has "$(cat "$CALLS")" "helper tcc-heal" "numeric 0 row: the rung runs"
}
