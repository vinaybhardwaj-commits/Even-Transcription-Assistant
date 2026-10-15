#!/bin/bash
# Static checks over the shipped files: G1 G4 G5 G7 and the toolchain limits.
SRC_FILES() { ls "$KDIR"/bin/*.sh "$KDIR"/lib/*.sh "$KDIR"/install.sh "$KDIR"/uninstall.sh; }
code_only() { grep -v '^[[:space:]]*#' "$@"; }

test_g1_no_kickstart_anywhere() {
  assert_eq "$(SRC_FILES | xargs grep -n 'kickstart' | grep -v '^[^:]*:[0-9]*:[[:space:]]*#' | wc -l | tr -d ' ')" "0" "no kickstart in code"
}
test_g4_no_deletes_in_heal_paths() {
  local n; n="$(code_only "$KDIR/lib/heal.sh" "$KDIR/lib/faulttree.sh" "$KDIR/lib/collect.sh" "$KDIR/lib/canary.sh" "$KDIR/bin/guardian-root.sh" "$KDIR/bin/guardian.sh" | grep -E '(^|[^a-z_])(rm|unlink|rmdir|srm|shred)[[:space:]]|DELETE FROM|DROP |truncate' | grep -v -F 'rm -f -- "$f"' | wc -l | tr -d ' ')"
  assert_eq "$n" "0" "no delete verbs in heal, tree, collect, helper, main (bar the helper's backup prune)"
  assert_eq "$(grep -c 'rm -f -- "\$f"' "$KDIR/bin/guardian-root.sh")" "1" "the helper deletes in exactly one place: prune_backups"
  assert_eq "$(SRC_FILES | xargs grep -n -i -E 'Cookies|Login Data|Local State|Google/Chrome' | wc -l | tr -d ' ')" "0" "no Chrome cookie or Preferences path"
  assert_eq "$(grep -c 'INSERT' "$KDIR/bin/guardian-root.sh")" "0" "TCC: UPDATE only, never INSERT"
}
test_g5_sudo_only_via_root_do() {
  local n; n="$(code_only "$KDIR"/lib/*.sh "$KDIR/bin/guardian.sh" | grep -E '(^|[^A-Za-z_$"])sudo[[:space:]]' | grep -v 'no sudo path' | wc -l | tr -d ' ')"
  assert_eq "$n" "0" "no bare sudo in the agent"
}
test_no_python_no_osascript() {
  assert_eq "$(SRC_FILES | xargs grep -n -E 'python3?|osascript' | grep -v '^[^:]*:[0-9]*:[[:space:]]*#' | wc -l | tr -d ' ')" "0" "toolchain"
}
test_g7_no_hosts_ips_keys_in_tree() {
  local all; all="$(find "$KDIR" -type f -not -path '*/tests/*' | xargs cat)"
  assert_not "$all" '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}' "no IPv4"
  assert_not "$all" 'ts\.net\|PRIVATE KEY\|ssh-ed25519 AAAA\|ssh-rsa AAAA\|ehrc-' "no hosts or keys"
  assert_eq "$(grep -rn -E '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' "$KDIR/tests" | grep -v -E 'PATH|version' | wc -l | tr -d ' ')" "0" "none in tests either"
}
test_control_topic_name() {
  assert_has "$(cat "$KDIR/lib/common.sh")" 'GUARDIAN_CONTROL_TOPIC guardian/control' "C4 ruling: topic guardian/control"
}
test_root_helper_refuses_unknown_user_and_verb() {
  unset GUARDIAN_ROOT_TESTMODE
  assert_eq "$("$KDIR/bin/guardian-root.sh" tcc-row ../etc)" "error:bad_user" "path-ish user refused"
  assert_eq "$("$KDIR/bin/guardian-root.sh" tcc-heal root 1)" "bad_user" "root refused"
}
