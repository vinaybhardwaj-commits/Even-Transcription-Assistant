#!/bin/bash
# R14 (R13 refute): ACL on the conf (A1), the conf's directory and the single open (A2), the PPID probe environment (A3), the system-only PATH (A4),
# the installer repairing a bad existing conf (A6). The live M1 test (A5) sits in t_r12.sh. Needs t_r12.sh's helpers (prod, r12_write_conf, r12_msg).
# shellcheck disable=SC2016,SC2030,SC2031
r14_acl_lines() { /bin/ls -led "$1" 2>/dev/null | wc -l | tr -d ' '; }   # 1 = no ACL entry
r14_inst() { GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" "$@"; }
r14_parse() { # <conf> [GUARDIAN_HOME]: "rc=N room=[x]" from a fresh subshell with the permission check on
  ( GUARDIAN_HOME="${2:-$GUARDIAN_HOME}"; . "$KDIR/lib/common.sh"; . "$KDIR/lib/conf.sh"; audit() { :; }; GUARDIAN_ROOM=""; conf_load "$1"; rc=$?; printf 'rc=%s room=[%s]' "$rc" "$GUARDIAN_ROOM" )
}

# A1. Any ACL entry on the conf rejects it, whatever the mode bits say.
test_r14_an_acl_on_the_conf_is_rejected() {
  r12_write_conf ""; r12_msg 1
  assert_has "$(prod -- check)" "killswitch=clear mode=heal" "positive control: 0600, no ACL"
  chmod +a "everyone allow write,append" "$GUARDIAN_HOME/guardian.conf"
  rm -f "$GUARDIAN_HOME/audit.log"
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=conf" "0600 + everyone-write ACL: killed"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "conf rejected: acl" "audit: acl"
  chmod -N "$GUARDIAN_HOME/guardian.conf"
  assert_has "$(prod -- check)" "killswitch=clear mode=heal" "ACL stripped: passes again"
  chmod +a "everyone allow read" "$GUARDIAN_HOME/guardian.conf"
  assert_has "$(prod -- check)" "why=conf" "even a read-only ACL entry rejects"
  chmod -N "$GUARDIAN_HOME/guardian.conf"
  # a rejected conf reads no key: a good body behind an ACL gives no room, run stops at rc 2
  chmod +a "everyone allow write" "$GUARDIAN_HOME/guardian.conf"
  prod -- run >/dev/null; assert_rc $? 2 "ACL conf: no key read, no room, rc 2"
}

# A1. An inheritable ACL on the parent directory must not reach the installed conf.
test_r14_install_strips_inherited_acls() {
  local par="$HOME/Library/Application Support/EvenScribe"
  rm -rf "$GUARDIAN_HOME"; mkdir -p "$par"
  chmod +a "everyone allow read,write,append,file_inherit,directory_inherit" "$par"
  printf 'GUARDIAN_ROOM="opd9"\nGUARDIAN_CONTROL_SUB_CMD='"'"'true'"'"'\n' >"$T/in.conf"
  r14_inst --config "$T/in.conf" >/dev/null 2>&1; assert_rc $? 0 "install under an inheritable ACL"
  assert_eq "$(r14_acl_lines "$GUARDIAN_HOME")" "1" "GUARDIAN_HOME: no ACL entry"
  assert_eq "$(r14_acl_lines "$GUARDIAN_HOME/guardian.conf")" "1" "conf: no ACL entry"
  assert_eq "$(/usr/bin/stat -f '%Lp' "$GUARDIAN_HOME")" "700" "GUARDIAN_HOME is 0700"
  assert_has "$(r14_parse "$GUARDIAN_HOME/guardian.conf")" "rc=0 room=\[opd9\]" "and the installed conf passes conf_load with the check on"
  rm -rf "$GUARDIAN_HOME"
  r14_inst >/dev/null 2>&1
  assert_eq "$(r14_acl_lines "$GUARDIAN_HOME/guardian.conf")" "1" "stub conf: no ACL entry"
  assert_has "$(r14_parse "$GUARDIAN_HOME/guardian.conf")" "rc=0 room=\[opd9\]" "stub conf passes"
  chmod -N "$par"
}

# A2. The conf's directory (and GUARDIAN_HOME) must be agent/root owned, not group/world-writable, no ACL.
test_r14_a_writable_conf_directory_is_rejected() {
  local out
  r12_write_conf ""; r12_msg 1
  assert_has "$(prod -- check)" "killswitch=clear mode=heal" "positive control: 0755 directory"
  chmod 700 "$GUARDIAN_HOME"; assert_has "$(prod -- check)" "killswitch=clear mode=heal" "0700 passes"
  chmod 777 "$GUARDIAN_HOME"; rm -f "$GUARDIAN_HOME/audit.log"
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=conf" "0777 directory: killed"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "conf rejected: dir" "audit: dir"
  chmod 770 "$GUARDIAN_HOME"; assert_has "$(prod -- check)" "why=conf" "group-writable directory: killed"
  chmod 702 "$GUARDIAN_HOME"; assert_has "$(prod -- check)" "why=conf" "other-write-only directory: killed"
  chmod 755 "$GUARDIAN_HOME"
  chmod +a "everyone allow add_file,delete_child" "$GUARDIAN_HOME"
  assert_has "$(prod -- check)" "why=conf" "an ACL on the directory: killed"
  chmod -N "$GUARDIAN_HOME"
  assert_has "$(prod -- check)" "killswitch=clear mode=heal" "ACL stripped: passes again"
  # a conf in a good directory, but GUARDIAN_HOME itself writable
  mkdir -p "$T/good"; cp "$GUARDIAN_HOME/guardian.conf" "$T/good/g.conf"; chmod 600 "$T/good/g.conf"; chmod 777 "$GUARDIAN_HOME"
  out="$(r14_parse "$T/good/g.conf")"; assert_has "$out" "rc=1" "GUARDIAN_HOME writable: rejected even when the conf sits elsewhere"
  chmod 755 "$GUARDIAN_HOME"
}

# A2. The refuter's repro: a 0777 directory and a swap loop. 150 checks, 0 parses of the swapped content.
test_r14_swap_loop_in_a_writable_directory_never_parses() {
  local d="$T/swap" n=0 evil=0 rejected=0 out sp
  mkdir -p "$d"; chmod 777 "$d"
  printf 'GUARDIAN_ROOM="good"\n' >"$T/good.src"; printf 'GUARDIAN_ROOM="evil"\n' >"$T/evil.src"
  cp "$T/good.src" "$d/guardian.conf"; chmod 600 "$d/guardian.conf"
  ( while :; do
      cp "$T/evil.src" "$d/x"; chmod 666 "$d/x"; mv -f "$d/x" "$d/guardian.conf"
      cp "$T/good.src" "$d/y"; chmod 600 "$d/y"; mv -f "$d/y" "$d/guardian.conf"
    done ) &
  sp=$!
  while [ "$n" -lt 150 ]; do
    out="$(r14_parse "$d/guardian.conf" "$d")"
    case "$out" in *"room=[evil]"*) evil=$((evil + 1)) ;; esac
    case "$out" in "rc=1 room=[]") rejected=$((rejected + 1)) ;; esac
    n=$((n + 1))
  done
  kill "$sp" 2>/dev/null; wait "$sp" 2>/dev/null
  assert_eq "$evil" "0" "0 parses of the swapped content in 150 checks"
  assert_eq "$rejected" "150" "every one of the 150 checks was rejected on the directory"
}

# A2. The file is opened once: one redirect from "$file" in conf_load, and the checks read the in-memory copy (a later swap cannot change what was parsed).
test_r14_conf_is_opened_once() {
  local body
  body="$(sed -n '/^conf_load()/,/^}/p' "$KDIR/lib/conf.sh")"
  assert_eq "$(printf '%s\n' "$body" | grep -c '<"\$file"')" "1" "conf_load: exactly one open of the path"
  assert_eq "$(printf '%s\n' "$body" | grep -c 'G_WC\|G_CAT\|source\|^ *\. ')" "0" "no wc, cat or source of the path"
  # size and bytes come from the copy: a 16385-byte file is over the cap, 16384 is not
  printf '# %s\n' "$(head -c 16381 /dev/zero | tr '\0' x)" >"$T/c16384.conf"
  assert_eq "$(/usr/bin/wc -c <"$T/c16384.conf" | tr -d ' ')" "16384" "fixture is 16384 bytes"
  assert_has "$(r14_parse "$T/c16384.conf" "$T")" "rc=0" "16384 bytes: accepted"
  printf '# %s\n' "$(head -c 16382 /dev/zero | tr '\0' x)" >"$T/c16385.conf"
  assert_has "$(r14_parse "$T/c16385.conf" "$T")" "rc=1" "16385 bytes: over the cap"
}

# A3. A forged BASH_FUNC_echo (sh imports functions) used to set MAIN_PID / LOOP_ME to a long-lived pair; after SIGKILL of main the transport shells stayed up.
test_r14_forged_echo_cannot_pin_the_loops_to_decoy_pids() {
  local d="$T/echo" h a b p i alive forge
  h="$d/home"; mkdir -p "$d" "$h/state"
  # the decoy pair: A (a subshell) and B (its child), both long-lived, B's parent is A
  ( /bin/sleep 1000 & echo $! >"$d/b.pid"; wait ) &
  echo $! >"$d/a.pid"
  i=0; while [ ! -s "$d/b.pid" ] && [ "$i" -lt 20 ]; do sleep 0.2; i=$((i + 1)); done
  a="$(cat "$d/a.pid")"; b="$(cat "$d/b.pid")"
  forge="() { if [ -e $d/first ]; then printf '%s\\n' $b; else : >$d/first; printf '%s\\n' $a; fi; }"
  {
    printf 'GUARDIAN_ROOM="opd9"\n'
    printf "GUARDIAN_PUBLISH_CMD='cat >/dev/null'\n"
    printf "GUARDIAN_SUBSCRIBE_CMD='echo \$\$ >>%s/sub.pid; sleep 1013 & echo \$! >>%s/sub.pid; wait'\n" "$d" "$d"
    printf "GUARDIAN_CONTROL_SUB_CMD='echo \$\$ >>%s/ctl.pid; sleep 1014 & echo \$! >>%s/ctl.pid; wait'\n" "$d" "$d"
    printf 'GUARDIAN_SUDO=""\n'
  } >"$h/guardian.conf"
  chmod 600 "$h/guardian.conf"
  ( exec /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" 'BASH_FUNC_echo%%'="$forge" \
      /bin/bash -p "$KDIR/bin/guardian.sh" run >"$d/run.out" 2>&1 ) &
  echo $! >"$d/main.pid"
  i=0; while { [ "$(wc -l <"$d/sub.pid" 2>/dev/null | tr -d ' ')" != 2 ] || [ "$(wc -l <"$d/ctl.pid" 2>/dev/null | tr -d ' ')" != 2 ]; } && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
  alive=0; for p in $(cat "$d/sub.pid" "$d/ctl.pid" 2>/dev/null); do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done
  assert_eq "$alive" "4" "both transport shells and both sleeps are up"
  kill -9 "$(cat "$d/main.pid")" 2>/dev/null
  i=0
  while [ "$i" -lt 30 ]; do
    alive=0; for p in $(cat "$d/sub.pid" "$d/ctl.pid" 2>/dev/null); do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done
    [ "$alive" -eq 0 ] && break
    sleep 0.5; i=$((i + 1))
  done
  assert_eq "$alive" "0" "forged echo: 0 Guardian processes alive 15 s after SIGKILL of main"
  kill "$a" "$b" 2>/dev/null; wait 2>/dev/null
}

# A4. The conf commands' PATH is the four system directories.
test_r14_child_path_is_system_directories_only() {
  assert_eq "$( . "$KDIR/lib/common.sh"; printf '%s' "$G_CHILD_PATH" )" "/usr/bin:/bin:/usr/sbin:/sbin" "G_CHILD_PATH"
  assert_not "$(grep -n 'homebrew\|/usr/local/bin' "$KDIR/lib/common.sh" | grep 'g_const G_CHILD_PATH')" "homebrew" "no Homebrew directory in the constant"
}

# A6. install.sh repairs an existing conf that fails the agent's check, even when its content is identical, and never writes through a symlink.
test_r14_install_repairs_a_bad_existing_conf() {
  local c="$GUARDIAN_HOME/guardian.conf" sum before out
  printf 'GUARDIAN_ROOM="opd9"\nGUARDIAN_CONTROL_SUB_CMD='"'"'true'"'"'\n' >"$T/in.conf"
  rm -rf "$GUARDIAN_HOME"; r14_inst --config "$T/in.conf" >/dev/null 2>&1
  out="$(r14_inst --config "$T/in.conf" 2>&1)"; assert_has "$out" "unchanged: $c" "a good conf with identical content: unchanged"
  # 1. mode 0666, identical content
  chmod 666 "$c"; out="$(r14_inst --config "$T/in.conf" 2>&1)"
  assert_eq "$(/usr/bin/stat -f '%Lp' "$c")" "600" "0666 identical conf repaired to 0600"
  assert_not "$out" "unchanged: $c" "and not reported unchanged"
  # 2. ACL, identical content
  chmod +a "everyone allow write,append" "$c"; r14_inst --config "$T/in.conf" >/dev/null 2>&1
  assert_eq "$(r14_acl_lines "$c")" "1" "ACL on an identical conf stripped"
  assert_eq "$(/usr/bin/stat -f '%Lp' "$c")" "600" "mode 0600 after the ACL repair"
  # 3. a symlink to an identical file: the target is never modified, the name becomes a regular file
  cp "$T/in.conf" "$T/target.conf"; chmod 666 "$T/target.conf"; sum="$(cksum <"$T/target.conf")"; before="$(/usr/bin/stat -f '%Lp %m' "$T/target.conf")"
  rm -f "$c"; ln -s "$T/target.conf" "$c"
  r14_inst --config "$T/in.conf" >/dev/null 2>&1; assert_rc $? 0 "install over a symlink"
  [ ! -L "$c" ] && [ -f "$c" ] && ok || fail "the symlink was replaced by a regular file"
  assert_eq "$(cksum <"$T/target.conf")" "$sum" "symlink target content untouched"
  assert_eq "$(/usr/bin/stat -f '%Lp %m' "$T/target.conf")" "$before" "symlink target mode and mtime untouched"
  assert_has "$(r14_parse "$c")" "rc=0 room=\[opd9\]" "the repaired conf passes conf_load"
  # 4. no --config: an existing 0666 conf is repaired in place of content
  chmod 666 "$c"; r14_inst >/dev/null 2>&1
  assert_eq "$(/usr/bin/stat -f '%Lp' "$c")" "600" "no --config: 0666 conf repaired"
  assert_has "$(r14_parse "$c")" "rc=0 room=\[opd9\]" "with its own content"
  # 5. no --config over a symlink
  rm -f "$c"; ln -s "$T/target.conf" "$c"; r14_inst >/dev/null 2>&1
  [ ! -L "$c" ] && ok || fail "no --config: symlink replaced"
  assert_eq "$(cksum <"$T/target.conf")" "$sum" "no --config: target content untouched"
  # nothing left behind, and a rerun is a no-op
  assert_eq "$(find "$GUARDIAN_HOME" -maxdepth 1 -name '.guardian.conf.*' | wc -l | tr -d ' ')" "0" "no temp file left"
  out="$(r14_inst --config "$T/in.conf" 2>&1)"; assert_has "$out" "unchanged: $c" "a repaired conf is unchanged on the next run"
  # dry-run touches nothing
  chmod 666 "$c"; r14_inst --config "$T/in.conf" --dry-run >/dev/null 2>&1
  assert_eq "$(/usr/bin/stat -f '%Lp' "$c")" "666" "dry-run does not repair"
}
