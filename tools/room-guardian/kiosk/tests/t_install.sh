#!/bin/bash
# Install / uninstall (spec 2.6): idempotent, dry-run, leaves nothing.
snap() { ( cd "$T" && find home -print | LC_ALL=C sort ); }
tree_sum() { ( cd "$T" && find home -type f -exec cksum {} + | LC_ALL=C sort ); }
inst() { GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" "$@"; }
uninst() { GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/uninstall.sh" --sudo "$T/bin/fakesudo" "$@"; }

test_dry_run_changes_nothing() {
  rm -rf "$GUARDIAN_HOME"; local before; before="$(snap)"
  inst --dry-run >"$T/out"; assert_eq "$(snap)" "$before" "dry-run install"
  assert_has "$(cat "$T/out")" "DRY-RUN" "says what it would do"
  assert_not "$(cat "$CALLS")" "launchctl" "no launchctl"
}

test_install_idempotent_and_uninstall_leaves_nothing() {
  rm -rf "$GUARDIAN_HOME"; local before; before="$(snap)"
  inst >/dev/null; assert_rc $? 0 "install"
  [ -x "$GUARDIAN_HOME/bin/guardian.sh" ] && ok || fail "guardian.sh installed"
  [ -f "$GUARDIAN_HOME/keys/id_ed25519.pub" ] && ok || fail "per-room key generated"
  [ -f "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist" ] && ok || fail "plist"
  [ -x "$T/libexec/eta-guardian-root" ] && ok || fail "root helper via sudo path"
  assert_not "$(cat "$CALLS")" "launchctl bootstrap" "install does not load the agent"
  assert_eq "$(stat -f %Lp "$GUARDIAN_HOME/keys/id_ed25519")" "600" "private key mode"
  assert_has "$(cat "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist")" "$GUARDIAN_HOME/bin/guardian.sh" "plist rendered"
  local a b; a="$(tree_sum)"; inst >/dev/null; b="$(tree_sum)"
  assert_eq "$b" "$a" "second install changes nothing"
  uninst >/dev/null; assert_rc $? 0 "uninstall"
  rm -rf "$T/libexec"
  [ -f "$HOME/Library/LaunchAgents/com.enrol.keep" ] || true
  assert_eq "$(snap)" "$before" "uninstall leaves nothing behind"
  uninst >/dev/null; assert_rc $? 0 "uninstall twice is fine"
}

test_uninstall_never_touches_the_recorder() {
  rm -rf "$GUARDIAN_HOME"; inst >/dev/null
  uninst >/dev/null
  [ -e "$RR_PLIST" ] && ok || fail "recorder plist kept"
  [ -d "$RR_ROOT" ] && ok || fail "recorder data kept"
  assert_not "$(cat "$CALLS")" "com.evenscribe.room-recorder" "no launchctl on the recorder"
}

test_uninstall_refuses_wrong_dir() {
  GUARDIAN_HOME="$T/home/precious" bash "$KDIR/uninstall.sh" >/dev/null 2>&1
  assert_rc $? 2 "refuses a path not ending in /Guardian"
}
