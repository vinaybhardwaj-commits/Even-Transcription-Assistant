#!/bin/bash
# Install / uninstall (spec 2.6): idempotent, dry-run, leaves nothing.
snap() { ( cd "$T" && find home libexec -print 2>/dev/null | LC_ALL=C sort ); }
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

test_uninstall_removes_tcc_backups_and_keeps_tcc_db() {
  rm -rf "$GUARDIAN_HOME"; mk_tcc 2
  : >"$T/TCC.db.bak-guardian-1791955000"; : >"$T/TCC.db.bak-guardian-1791955100"
  inst >/dev/null; uninst >/dev/null; assert_rc $? 0 "uninstall"
  assert_eq "$(ls "$T"/TCC.db.bak-guardian-* 2>/dev/null | wc -l | tr -d ' ')" "0" "no backup left beside TCC.db"
  [ -s "$T/TCC.db" ] && ok || fail "TCC.db itself is not ours and stays"
}

test_root_helper_prune_only_touches_our_backups() {
  mk_tcc 2
  : >"$T/TCC.db.bak-guardian-100"; : >"$T/TCC.db.bak-guardian-200"; : >"$T/TCC.db.bak-guardian-xyz"; : >"$T/TCC.db.bak-other"
  "$GUARDIAN_ROOT_HELPER" tcc-prune x 1 >/dev/null
  assert_eq "$(for f in "$T"/TCC.db.bak-*; do printf "%s " "${f##*/}"; done)" "TCC.db.bak-guardian-200 TCC.db.bak-guardian-xyz TCC.db.bak-other " "newest numeric kept; others untouched"
  assert_eq "$("$GUARDIAN_ROOT_HELPER" tcc-prune x 5)" "bad_keep" "keep is 0 or 1 only"
}
