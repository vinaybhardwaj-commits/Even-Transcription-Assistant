#!/bin/bash
# R15 (Fable gate G14-3 i, ii; the d2 refute N3): the code tree and every ancestor of it, at install and at run time; once/handle under bash -p.
# All of it sandboxed: GUARDIAN_HOME, HOME and the helper path live under $T. Nothing here touches the real EvenScribe directory, a kiosk, launchd or the log.
# Needs t_r12.sh's helpers (prod, r12_write_conf, r12_msg, r13_live_start and friends) and t_r14.sh's (r14_acl_lines).
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154

r15_inst() { GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" "$@"; }
# the INSTALLED copy, in production shape (env -i, bash -p, the real clock), capped like prod
r15_agent() { "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" /bin/bash -p "$GUARDIAN_HOME/bin/guardian.sh" "$@" 2>/dev/null; }
# the same, but prints "rc=N out=[stdout] err=[stderr]" (the R15b pre-source check speaks on stderr and exits 3)
r15_pre() {
  local out rc
  out="$("${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="${R15_PATH:-$PROD_PATH}" /bin/bash -p "$GUARDIAN_HOME/bin/guardian.sh" "$@" 2>"$T/pre.err")"; rc=$?
  printf 'rc=%s out=[%s] err=[%s]' "$rc" "$out" "$(cat "$T/pre.err")"
}
# a mkdir that refuses any path outside the sandbox: a regressed refusal can then never create anything under /tmp or anywhere else
r15_guard_mkdir() {
  cat >"$T/bin/mkdir" <<F
#!/bin/bash
for a in "\$@"; do case "\$a" in -*) ;; "$T"|"$T"/*) ;; *) echo "guard: mkdir outside the sandbox refused: \$a" >&2; exit 1 ;; esac; done
exec /bin/mkdir "\$@"
F
  chmod +x "$T/bin/mkdir"
}
# a fresh install, a clean conf, a fresh heal message: the positive control reads "killswitch=clear mode=heal"
r15_ready() { rm -rf "$GUARDIAN_HOME"; r15_inst >/dev/null 2>&1; r12_write_conf ""; r12_msg 5; }
R15_PAR_REL="Library/Application Support/EvenScribe"
r15_shape_on() {
  local par="$HOME/$R15_PAR_REL" asup="$HOME/Library/Application Support"
  case "$1" in
    gw) chmod 775 "$par" ;;
    ww) chmod 777 "$asup" ;;
    acl) chmod +a "everyone allow write,append" "$HOME/Library" ;;
    aclinh) chmod +a "everyone allow read,write,append,file_inherit,directory_inherit" "$par" ;;
    symlink) mv "$par" "$par.real"; ln -s "$par.real" "$par" ;;
  esac
}
r15_shape_off() {
  local par="$HOME/$R15_PAR_REL" asup="$HOME/Library/Application Support"
  case "$1" in
    gw) chmod 755 "$par" ;;
    ww) chmod 755 "$asup" ;;
    acl) chmod -N "$HOME/Library" ;;
    aclinh) chmod -N "$par" ;;
    symlink) rm "$par"; mv "$par.real" "$par" ;;
  esac
}
r15_mode_of() { /usr/bin/stat -f '%Lp' "$1"; }

# (i) + (ii): each bad ancestor shape. The agent runs killed (why=tree) and clears when the shape is undone; the installer repairs what the agent user owns and refuses the rest.
test_r15_every_bad_ancestor_shape_kills_the_agent_and_install_repairs_or_refuses() {
  local sh out par="$HOME/$R15_PAR_REL" before after
  for sh in gw ww acl aclinh; do
    r15_ready
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "$sh: positive control (clean ancestors)"
    r15_shape_on "$sh"
    assert_has "$(r15_agent check)" "killswitch=engaged mode=shadow why=tree" "$sh: the agent is killed"
    assert_has "$(grep 'code tree check' "$GUARDIAN_HOME/audit.log" | tail -n1)" "ancestor" "$sh: audited, naming an ancestor"
    r15_shape_off "$sh"; r12_msg 5
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "$sh: undone, the agent is clear again"
    # the installer repairs it (the agent user owns every ancestor in the sandbox) and says so
    r15_shape_on "$sh"
    out="$(r15_inst 2>&1)"; assert_rc $? 0 "$sh: install repairs"
    assert_has "$out" "repaired:" "$sh: each repair is logged"
    r12_msg 5
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "$sh: clear after the repair"
  done
  assert_eq "$(r15_mode_of "$HOME/Library/Application Support")" "755" "ww: world write removed, the rest kept"
  # a symlinked ancestor owned by the agent user: the agent is killed, the installer refuses and writes nothing
  r15_ready; r15_shape_on symlink
  # R16b: a symlink on the path the agent was started by is now refused by the pre-source check (exit 3, nothing loaded), before tree_check can name it: the agent does not start
  out="$(r15_pre check)"; assert_has "$out" "rc=3 " "symlink: the agent exits 3"; assert_has "$out" "symlink:" "symlink: stderr names the symlink"
  assert_not "$out" "killswitch=clear" "symlink: the agent does not start"
  before="$(find "$par.real" -type f -exec cksum {} + | LC_ALL=C sort)"
  out="$(r15_inst 2>&1)"; assert_rc $? 2 "symlink: install refuses"
  assert_has "$out" "refusing: ancestor" "symlink: says so"
  after="$(find "$par.real" -type f -exec cksum {} + | LC_ALL=C sort)"
  assert_eq "$after" "$before" "symlink: nothing installed through the link"
  r15_shape_off symlink
}

# The macOS default entry "group:everyone deny delete" on an ancestor is not a fault, and the installer's repair leaves it in place.
test_r15_the_default_deny_delete_acl_is_accepted_and_kept() {
  local par="$HOME/$R15_PAR_REL" out
  r15_ready
  chmod +a "group:everyone deny delete" "$par"
  assert_eq "$(r14_acl_lines "$par")" "2" "fixture: the default entry is there"
  assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "default entry only: clear"
  # a second, extra entry: killed; the installer removes that one and keeps the default
  chmod +a "everyone allow write" "$par"
  assert_has "$(r15_agent check)" "why=tree" "default plus an extra entry: killed"
  out="$(r15_inst 2>&1)"; assert_rc $? 0 "install repairs the extra entry"
  assert_has "$out" "repaired: removed ACL entry" "logged"
  assert_eq "$(r14_acl_lines "$par")" "2" "the default entry is still there"
  assert_has "$(/bin/ls -led "$par" | tail -n1)" "group:everyone deny delete" "and it is the default one"
  r12_msg 5; assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "clear again"
  chmod -N "$par"
}

# A root-owned writable ancestor is refused (nothing created); --dry-run says so and still creates nothing. /tmp is a real root-owned sticky world-writable directory, so the path is
# named there, but this test can never create or remove anything in it: mkdir is a sandbox guard (a regressed scan would fail on it) and the test deletes nothing.
test_r15_a_root_owned_writable_ancestor_is_refused_and_nothing_is_installed() {
  local g="/tmp/r15-refuse-$$-$RANDOM/Guardian" out
  r15_guard_mkdir
  out="$(GUARDIAN_HOME="$g" r15_inst 2>&1)"; assert_rc $? 2 "install into a root-owned writable ancestor: rc 2"
  assert_has "$out" "refusing: ancestor" "says which"
  assert_not "$out" "guard: mkdir outside the sandbox" "the refusal came from the scan, not from the guard"
  [ ! -e "${g%/Guardian}" ] && ok || fail "nothing was created under /tmp"
  out="$(GUARDIAN_HOME="$g" r15_inst --dry-run 2>&1)"; assert_rc $? 2 "dry-run reports the refusal with rc 2"
  assert_has "$out" "DRY-RUN: would refuse: ancestor" "dry-run says would refuse"
  [ ! -e "${g%/Guardian}" ] && ok || fail "dry-run created nothing"
  [ ! -e "$T/libexec/eta-guardian-root" ] && [ ! -e "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist" ] && ok || fail "no helper and no plist were installed"
}

# R15b (refute NOTE 2, MU5): the installer end to end on a real foreign-owned ancestor (a system directory owned by a service uid; the installer's scan pins /usr/bin/id, so the foreign
# owner is real, not faked). Refused with rc 2 naming the ancestor; --dry-run says would refuse; nothing is created. mkdir is the sandbox guard.
test_r15b_install_refuses_a_foreign_owned_ancestor_end_to_end() {
  local fo="" cand out g
  r15_guard_mkdir
  for cand in /private/var/sntpd /private/var/networkd; do
    [ -d "$cand" ] && [ "$(/usr/bin/stat -f %u "$cand")" != 0 ] && [ "$(/usr/bin/stat -f %u "$cand")" != "$(id -u)" ] && [ ! -w "$cand" ] && { fo="$cand"; break; }
  done
  if [ -z "$fo" ]; then fail "no foreign-owned, unwritable system directory on this machine to probe with"; return; fi
  g="$fo/r15b-never/Guardian"
  out="$(GUARDIAN_HOME="$g" r15_inst 2>&1)"; assert_rc $? 2 "install under a foreign-owned ancestor: rc 2"
  assert_has "$out" "refusing: ancestor $fo: owner" "the foreign owner is named"
  out="$(GUARDIAN_HOME="$g" r15_inst --dry-run 2>&1)"; assert_rc $? 2 "dry-run: rc 2"
  assert_has "$out" "DRY-RUN: would refuse: ancestor $fo: owner" "dry-run says would refuse"
  [ ! -e "$fo/r15b-never" ] && ok || fail "nothing was created"
  [ ! -e "$T/libexec/eta-guardian-root" ] && [ ! -e "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist" ] && ok || fail "no helper and no plist were installed"
}

# The scanner itself: a foreign owner (the id is faked, so every sandbox directory looks foreign) and a root-owned writable ancestor are X (refuse / kill) findings.
test_r15_scanner_foreign_owner_and_root_writable_are_refusals() {
  local out
  printf '#!/bin/bash\necho 4242\n' >"$T/bin/fakeid"; chmod +x "$T/bin/fakeid"
  out="$( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; G_STAT=/usr/bin/stat; G_LS=/bin/ls; G_ID="$T/bin/fakeid"; G_CAT=/bin/cat; G_MKDIR=/bin/mkdir; audit() { :; }
          . "$KDIR/lib/conf.sh"; tree_walk_anc "$GUARDIAN_HOME" 1 )"
  assert_has "$out" "^X|owner|.*/sb\\.${HOME##*/sb.}\$" "a directory owned by neither root nor the agent uid: refuse"
  out="$( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; G_STAT=/usr/bin/stat; G_LS=/bin/ls; G_ID="$T/bin/fakeid"; G_CAT=/bin/cat; G_MKDIR=/bin/mkdir; audit() { :; }
          . "$KDIR/lib/conf.sh"; mkdir -p "$T/tree/bin" "$T/tree/lib"; tree_check_paths "$T/tree" "$T/tree"; echo "rc=$? why=[$G_TREE_WHY]" )"
  assert_has "$out" "rc=1 why=\[dir owner: \.\]" "the agent's own check fails on the foreign owner"
  out="$( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; G_STAT=/usr/bin/stat; G_LS=/bin/ls; G_ID=/usr/bin/id; G_CAT=/bin/cat; G_MKDIR=/bin/mkdir; audit() { :; }
          . "$KDIR/lib/conf.sh"; tree_walk_anc /tmp/r15-never-created/x 1 )"
  assert_has "$out" "^X|writable|/private/tmp" "a root-owned world-writable ancestor (through the root-owned /tmp link): refuse"
  assert_not "$out" "^X|symlink" "the root-owned system link itself is not a fault"
}

# Upgrade over an inherited everyone-write ACL and loose modes: gone after the install, on bin/, lib/ and the files, whether or not the file was rewritten.
test_r15_upgrade_install_strips_acls_and_loose_modes_from_the_code_tree() {
  local g p
  r15_ready; g="$GUARDIAN_HOME"
  for p in "$g/bin" "$g/lib" "$g/lib/common.sh" "$g/bin/guardian.sh"; do
    chmod +a "everyone allow write,append" "$p"
    assert_eq "$(r14_acl_lines "$p")" "2" "fixture: ACL on ${p#"$g"/}"
  done
  printf '# changed\n' >>"$g/lib/heal.sh"      # this file differs, so it is rewritten; the others are "unchanged"
  chmod 666 "$g/lib/probe.sh"; chmod 777 "$g/lib" "$g/bin"
  r15_inst >/dev/null 2>&1; assert_rc $? 0 "upgrade install"
  for p in "$g/bin" "$g/lib" "$g/lib/common.sh" "$g/bin/guardian.sh" "$g/lib/heal.sh" "$g/lib/probe.sh"; do
    assert_eq "$(r14_acl_lines "$p")" "1" "no ACL on ${p#"$g"/}"
  done
  assert_eq "$(r15_mode_of "$g/bin")" "755" "bin 0755"
  assert_eq "$(r15_mode_of "$g/lib")" "755" "lib 0755"
  assert_eq "$(r15_mode_of "$g/lib/probe.sh")" "644" "probe.sh back to 0644"
  assert_eq "$(r15_mode_of "$g/bin/guardian.sh")" "755" "guardian.sh 0755"
  assert_eq "$(r15_mode_of "$g")" "700" "GUARDIAN_HOME stays 0700"
  cmp -s "$KDIR/lib/heal.sh" "$g/lib/heal.sh" && ok || fail "heal.sh was rewritten from the source"
  r12_msg 5; assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "the agent is clear on the upgraded tree"
  # a symlinked code file is replaced by a regular file; the target is never written through
  printf 'precious\n' >"$T/target.sh"; rm "$g/lib/heal.sh"; ln -s "$T/target.sh" "$g/lib/heal.sh"
  assert_has "$(r15_pre check)" "rc=3 .*symlink: " "a symlinked code file: the pre-source check refuses to start (exit 3)"
  r15_inst >/dev/null 2>&1; assert_rc $? 0 "install over a symlinked code file"
  [ -f "$g/lib/heal.sh" ] && [ ! -L "$g/lib/heal.sh" ] && ok || fail "the link was replaced by a regular file"
  assert_eq "$(cat "$T/target.sh")" "precious" "the link target is untouched"
  # a symlinked lib/ is refused outright
  mv "$g/lib" "$T/lib.real"; ln -s "$T/lib.real" "$g/lib"
  r15_inst >/dev/null 2>&1; assert_rc $? 2 "a symlinked lib/ is refused"
  rm "$g/lib"; mv "$T/lib.real" "$g/lib"
}

# umask 000 gives the same modes as umask 022 (parents, bin, lib, state, flags and the files).
test_r15_install_under_umask_000_gives_the_same_modes_as_022() {
  local u modes_000 modes_022
  for u in 000 022; do
    (
      umask "$u"
      mkdir -p "$T/u$u/home/Library"
      export HOME="$T/u$u/home"
      GUARDIAN_HOME="$HOME/Library/Application Support/EvenScribe/Guardian" LA_DIR="$HOME/Library/LaunchAgents" GUARDIAN_ROOT_HELPER="$T/u$u/libexec/eta-guardian-root" \
        bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" >"$T/u$u.out" 2>&1
    )
    assert_rc $? 0 "install under umask $u"
  done
  modes_000="$(cd "$T/u000" && find home libexec -exec /usr/bin/stat -f '%Lp %N' {} + | LC_ALL=C sort)"
  modes_022="$(cd "$T/u022" && find home libexec -exec /usr/bin/stat -f '%Lp %N' {} + | LC_ALL=C sort)"
  assert_eq "$modes_000" "$modes_022" "the same modes under umask 000 and 022"
  assert_has "$modes_000" "^755 home/Library/Application Support/EvenScribe\$" "the parent is not group/world-writable"
  assert_has "$modes_000" "^755 home/Library/Application Support/EvenScribe/Guardian/state\$" "state"
  assert_has "$modes_000" "^755 home/Library/Application Support/EvenScribe/Guardian/flags\$" "flags"
  assert_has "$modes_000" "^700 home/Library/Application Support/EvenScribe/Guardian\$" "GUARDIAN_HOME"
}

# --dry-run reports what it would repair and changes nothing.
test_r15_dry_run_reports_repairs_and_changes_nothing() {
  local par="$HOME/$R15_PAR_REL" out snap
  r15_ready
  chmod 777 "$par"; chmod +a "everyone allow write" "$HOME/Library"
  snap="$(cd "$T" && find home -exec /usr/bin/stat -f '%Lp %N' {} + | LC_ALL=C sort)"
  out="$(r15_inst --dry-run 2>&1)"; assert_rc $? 0 "dry-run rc 0"
  par="$(printf '%s' "$par" | sed 's|//|/|g')"   # the scanner prints each path without the doubled slash TMPDIR leaves
  assert_has "$out" "DRY-RUN: would repair: chmod go-w $par" "mode repair reported"
  assert_has "$out" "DRY-RUN: would repair: remove ACL entry 0 from $(printf '%s' "$HOME" | sed 's|//|/|g')/Library" "ACL repair reported"
  assert_eq "$(r15_mode_of "$par")" "777" "dry-run: mode untouched"
  assert_eq "$(r14_acl_lines "$HOME/Library")" "2" "dry-run: ACL untouched"
  assert_eq "$(cd "$T" && find home -exec /usr/bin/stat -f '%Lp %N' {} + | LC_ALL=C sort)" "$snap" "dry-run: no mode moved anywhere"
  chmod -N "$HOME/Library"
}

# (ii) the code tree loosened while the agent is down: since R15b the pre-source check refuses to start at all (exit 3, one stderr line, nothing sourced); restored = clear.
# (A tree loosened while the agent RUNS is killed by the per-tick tree_check and health keeps flowing: the live-run test below.)
test_r15_loosened_code_tree_stops_the_start_and_restoring_it_clears() {
  local g sh out
  r15_ready; g="$GUARDIAN_HOME"
  assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "positive control"
  for sh in "g+w lib/heal.sh" "o+w bin/guardian.sh" "g+w lib/common.sh" "g+w lib/conf.sh" "g+w lib/killswitch.sh" "g+w lib/canary.sh" "g+w lib" "o+w bin" "g+w ."; do
    chmod "${sh%% *}" "$g/${sh#* }"
    out="$(r15_pre check)"
    assert_has "$out" "rc=3 out=\[\] err=\[guardian: code tree unsafe (writable: " "$sh: exit 3, nothing on stdout, one stderr line"
    chmod "$(printf '%s' "${sh%% *}" | tr '+' '-')" "$g/${sh#* }"; r12_msg 5
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "$sh: restored, clear"
  done
  for sh in bin lib lib/heal.sh bin/guardian.sh lib/faulttree.sh lib/probe.sh lib/collect.sh; do
    chmod +a "everyone allow write,append" "$g/$sh"
    assert_has "$(r15_pre check)" "rc=3 .*(acl: " "ACL on $sh: exit 3, reason acl"
    chmod -N "$g/$sh"; r12_msg 5
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "ACL on $sh stripped: clear"
  done
  # the macOS default entry is an ACL too, for code: the strict rule has no exception (the ancestors alone get one)
  chmod +a "group:everyone deny delete" "$g/lib/heal.sh"
  assert_has "$(r15_pre check)" "rc=3 .*(acl: " "the default deny-delete entry on a code file: exit 3"
  chmod -N "$g/lib/heal.sh"; r12_msg 5
  # an older install has no canary.sh: still clear (the tick skips it)
  mv "$g/lib/canary.sh" "$T/canary.moved"
  assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "no canary.sh: clear"
  mv "$T/canary.moved" "$g/lib/canary.sh"
}

# R15b S1: the pre-source check runs before ANY lib is sourced. A forged lib (its content would run as the agent) is never read; the start exits 3 with one stderr line.
test_r15b_pre_source_check_exits_3_before_sourcing_anything() {
  local g sh out n0 n1 fk="$T/fk"
  r15_ready; g="$GUARDIAN_HOME"
  assert_has "$(r15_pre check)" "rc=0 .*killswitch=clear mode=heal" "positive control: a clean tree starts"
  n0="$(grep -c 'guardian start' "$g/audit.log" 2>/dev/null)"
  printf '%s\n' "printf 'SOURCED\\n' >>\"$T/sourced.mark\"" 'tree_check(){ G_TREE_BAD=0; return 0; }' >>"$g/lib/heal.sh"
  : >"$T/sourced.mark"; chmod g+w "$g/lib/heal.sh"
  for sh in check once; do
    out="$(r15_pre "$sh")"
    assert_has "$out" "rc=3 out=\[\] err=\[guardian: code tree unsafe (writable: .*/Guardian/lib/heal.sh)" "forged group-writable heal.sh: $sh exits 3 and names the file"
  done
  assert_eq "$(wc -c <"$T/sourced.mark" | tr -d ' ')" "0" "the forged lib was never sourced"
  n1="$(grep -c 'guardian start' "$g/audit.log" 2>/dev/null)"
  assert_eq "$n1" "$n0" "nothing ran: no new 'guardian start' audit line"
  # the forged content with the tool lookups hijacked: fake stat, ls, id and dirname first in PATH say "clean"; the pinned absolute tools still see the file
  mkdir -p "$fk"
  printf '#!/bin/bash\necho "$(/usr/bin/id -u) 644 Regular File"\n' >"$fk/stat"
  printf '#!/bin/bash\necho "-rw-r--r-- 1 x y 1 Jan 1 00:00 f"\n' >"$fk/ls"
  printf '#!/bin/bash\necho 501\n' >"$fk/id"; printf '#!/bin/bash\necho "%s"\n' "$g/bin" >"$fk/dirname"; chmod +x "$fk"/*
  out="$(R15_PATH="$fk:$PROD_PATH" r15_pre check)"
  assert_has "$out" "rc=3 .*writable" "hijacked PATH tools do not fool the pre-source check"
  out="$(R15_PATH=/nonexistent r15_pre check)"
  assert_has "$out" "rc=3 .*writable" "an empty PATH changes nothing: no PATH lookup before the check"
  chmod g-w "$g/lib/heal.sh"; cp "$KDIR/lib/heal.sh" "$g/lib/heal.sh"; chmod 644 "$g/lib/heal.sh"
  # each shape, on the first lib that would be sourced and on the others
  for sh in "o+w bin/guardian.sh" "g+w lib/common.sh" "acl lib/conf.sh" "g+w lib" "g+w ." "o+w bin"; do
    case "${sh%% *}" in
      acl) chmod +a "everyone allow write" "$g/${sh#* }" ;;
      *) chmod "${sh%% *}" "$g/${sh#* }" ;;
    esac
    out="$(r15_pre check)"; assert_has "$out" "rc=3 .*code tree unsafe" "$sh: exit 3"
    case "${sh%% *}" in
      acl) chmod -N "$g/${sh#* }" ;;
      *) chmod "$(printf '%s' "${sh%% *}" | tr '+' '-')" "$g/${sh#* }" ;;
    esac
  done
  mv "$g/lib/probe.sh" "$T/probe.real"; ln -s "$T/probe.real" "$g/lib/probe.sh"
  assert_has "$(r15_pre check)" "rc=3 .*(symlink: " "a symlinked lib file: exit 3"
  rm "$g/lib/probe.sh"; mv "$T/probe.real" "$g/lib/probe.sh"
  mv "$g/lib/common.sh" "$T/common.real"
  assert_has "$(r15_pre check)" "rc=3 .*(missing: " "a missing lib: exit 3"
  mv "$T/common.real" "$g/lib/common.sh"
  r12_msg 5; assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "everything restored: clear"
  # exit 3 would restart the job every ThrottleInterval seconds (KeepAlive): the plist keeps that at 60 s or more, and stderr goes to guardian.err
  n1="$(sed -n 's|.*<key>ThrottleInterval</key><integer>\([0-9]*\)</integer>.*|\1|p' "$KDIR/launchd/com.evenscribe.room-guardian.plist.tmpl")"
  [ "${n1:-0}" -ge 60 ] && ok || fail "ThrottleInterval is $n1 s, expected at least 60"
  n1="$(sed -n 's|.*<key>ThrottleInterval</key><integer>\([0-9]*\)</integer>.*|\1|p' "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist")"
  [ "${n1:-0}" -ge 60 ] && ok || fail "the rendered plist has ThrottleInterval $n1 s"
  assert_has "$(cat "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist")" "guardian.err" "stderr goes to guardian.err"
}

# R15b S2: the shebang is `#!/bin/bash -p`, so ./guardian.sh never reads BASH_ENV. The hostile file defines exec() (which stops the builtin re-exec), pre-sets readonly USB_DPRIME_HEAL=1 and
# G_BAD_CONST=, and marks every shell that reads it. Control: a plain `bash -c true` does read it. `bash guardian.sh` by hand under it is out of the model (README).
test_r15b_shebang_entry_ignores_a_hostile_bash_env() {
  local d="$T/s2" h="$T/s2/home" f="$T/s2.rc" mark="$T/s2.mark" out
  r15_fix s2
  assert_eq "$(head -n1 "$KDIR/bin/guardian.sh")" "#!/bin/bash -p" "the shebang carries -p"
  assert_eq "$(head -n1 "$h/bin/guardian.sh")" "#!/bin/bash -p" "and so does the installed copy"
  assert_has "$(cat "$d/la/com.evenscribe.room-guardian.plist")" "<string>-p</string>" "the plist runs bash -p"
  { echo 'exec() { :; }'; echo 'readonly USB_DPRIME_HEAL=1 G_BAD_CONST='; printf "trap 'printf \"%%s dph=%%s\\n\" \"\$0\" \"\$USB_DPRIME_HEAL\" >>%s' EXIT\n" "$mark"; } >"$f"
  : >"$mark"
  # (the fake tools in $d/bin are bash scripts and do read it: only a shell whose $0 is guardian.sh counts)
  mkdir -p "$T/ctl"; printf '#!/bin/bash\n:\n' >"$T/ctl/guardian.sh"; chmod +x "$T/ctl/guardian.sh"
  /usr/bin/env -i PATH="$PROD_PATH" BASH_ENV="$f" /bin/bash "$T/ctl/guardian.sh"
  assert_eq "$(grep -c 'guardian.sh' "$mark")" "1" "control: a plain bash running a guardian.sh reads the hostile BASH_ENV"
  : >"$mark"
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" BASH_ENV="$f" ENV="$f" \
    "$h/bin/guardian.sh" once >/dev/null 2>&1
  assert_eq "$(grep -c 'guardian.sh' "$mark")" "0" "./guardian.sh once: the hostile BASH_ENV was never read by the agent's shell"
  assert_has "$(cat "$d/pub.log")" '"mode"' "once did run (a health line was published)"
  out="$("${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" BASH_ENV="$f" "$h/bin/guardian.sh" check 2>/dev/null)"
  assert_has "$out" "killswitch=" "./guardian.sh check ran"
  assert_eq "$(grep -c 'guardian.sh' "$mark")" "0" "./guardian.sh check: the hostile BASH_ENV was never read by the agent's shell"
}

# R15b S3: state/, flags/ and keys/ of the agent home. The installer refuses (rc 2, nothing installed) a symlink, a non-directory or a foreign owner; the agent is killed on a loosened one.
test_r15b_install_refuses_a_linked_or_foreign_state_flags_keys() {
  local g="$GUARDIAN_HOME" c d out fo="" cand n
  r15_guard_mkdir
  for cand in /private/var/sntpd /private/var/networkd; do
    [ -d "$cand" ] && [ "$(/usr/bin/stat -f %u "$cand")" != 0 ] && [ "$(/usr/bin/stat -f %u "$cand")" != "$(id -u)" ] && [ ! -w "$cand" ] && { fo="$cand"; break; }
  done
  mkdir -p "$T/elsewhere"
  for c in state_sticky flags_foreign keys_link state_file; do
    rm -rf "$g"; mkdir -p "$g"; chmod 700 "$g"
    case "$c" in
      state_sticky) d=state; ln -s /private/tmp "$g/state" ;;
      flags_foreign) d=flags; if [ -n "$fo" ]; then ln -s "$fo" "$g/flags"; else ln -s /private/var/empty "$g/flags"; fi ;;
      keys_link) d=keys; ln -s "$T/elsewhere" "$g/keys" ;;
      state_file) d=state; : >"$g/state" ;;
    esac
    out="$(r15_inst --dry-run 2>&1)"; assert_rc $? 2 "$c: dry-run rc 2"
    assert_has "$out" "DRY-RUN: would refuse: .*/$d is " "$c: dry-run says would refuse"
    out="$(r15_inst 2>&1)"; assert_rc $? 2 "$c: install refuses with rc 2"
    assert_has "$out" "refusing: .*/$d is " "$c: says which"
    n="$(find "$g" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
    assert_eq "$n" "1" "$c: nothing installed (only the planted $d is in GUARDIAN_HOME)"
    [ ! -e "$T/libexec/eta-guardian-root" ] && [ ! -e "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist" ] && ok || fail "$c: no helper and no plist"
    case "$c" in state_file) [ -f "$g/state" ] && ok || fail "$c: untouched" ;; *) [ -L "$g/$d" ] && ok || fail "$c: the link is untouched" ;; esac
  done
  # a real directory owned by someone else (the installer's id is faked; the ancestor scan pins /usr/bin/id and is not fooled)
  rm -rf "$g"; mkdir -p "$g/state"; chmod 700 "$g"
  mkdir -p "$T/fk"; printf '#!/bin/bash\n[ "$1" = -u ] && echo 4242 || exec /usr/bin/id "$@"\n' >"$T/fk/id"; chmod +x "$T/fk/id"
  out="$(PATH="$T/fk:$PATH" r15_inst 2>&1)"; assert_rc $? 2 "foreign-owned state/: rc 2"
  assert_has "$out" "refusing: .*/state is not owned by this user" "foreign owner named"
  [ ! -e "$g/bin" ] && ok || fail "foreign-owned state/: nothing installed"
  out="$(r15_inst 2>&1)"; assert_rc $? 0 "control: the same directory, owned by this user, installs"
  # a mkdir or chmod on them that fails is not ignored
  rm -rf "$g"; printf '#!/bin/bash\ncase "$*" in *state*) exit 1 ;; esac\nexec /bin/mkdir "$@"\n' >"$T/bin/mkdir"; chmod +x "$T/bin/mkdir"
  out="$(r15_inst 2>&1)"; assert_rc $? 1 "a failing mkdir of state/: rc 1"; assert_has "$out" "failed: mkdir" "says so"
  r15_guard_mkdir; rm -rf "$g"
  printf '#!/bin/bash\ncase "$*" in *keys*) exit 1 ;; esac\nexec /bin/chmod "$@"\n' >"$T/bin/chmod"; chmod +x "$T/bin/chmod"
  out="$(r15_inst 2>&1)"; assert_rc $? 1 "a failing chmod of keys/: rc 1"; assert_has "$out" "failed: chmod 700 keys" "says so"
  rm -f "$T/bin/chmod"
}

# R15b S3: tree_check_paths treats state/ and flags/ as strict directories: the agent is killed on a loosened, linked or ACL'd one and clear when it is restored.
r15_sf_shape() { # on|off <shape> <dir>
  local g="$GUARDIAN_HOME" d="$3"
  case "$1:$2" in
    on:gw) chmod g+w "$g/$d" ;;       off:gw) chmod g-w "$g/$d" ;;
    on:ww) chmod o+w "$g/$d" ;;       off:ww) chmod o-w "$g/$d" ;;
    on:acl) chmod +a "everyone allow write" "$g/$d" ;;   off:acl) chmod -N "$g/$d" ;;
    on:dd) chmod +a "group:everyone deny delete" "$g/$d" ;;   off:dd) chmod -N "$g/$d" ;;
    on:link) mv "$g/$d" "$g/$d.real"; ln -s "$g/$d.real" "$g/$d" ;;   off:link) rm "$g/$d"; mv "$g/$d.real" "$g/$d" ;;
  esac
}
test_r15b_state_and_flags_are_strict_directories_for_the_agent() {
  local g sh d shape
  r15_ready; g="$GUARDIAN_HOME"
  assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "positive control"
  for sh in gw:state ww:flags acl:state dd:flags link:flags link:state; do
    shape="${sh%%:*}"; d="${sh##*:}"
    r15_sf_shape on "$shape" "$d"
    assert_has "$(r15_agent check)" "killswitch=engaged mode=shadow why=tree" "$sh: killed"
    assert_has "$(cat "$g/state/tree_state")" "^bad dir .*: $d\$" "$sh: the reason names $d"
    r15_sf_shape off "$shape" "$d"; r12_msg 5
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "$sh: restored, clear"
  done
}

# NOTE 1 of the refute: the strict ACL rule has no default-entry exception on code files, state/ and flags/ (library level: tree_check_paths itself, past the pre-source check).
test_r15b_strict_mode_rejects_the_default_deny_delete_entry_on_code_state_and_flags() {
  local g p out
  r15_ready; g="$GUARDIAN_HOME"
  r15_lib_paths() { ( G_TR=/usr/bin/tr; G_WC=/usr/bin/wc; G_HEAD=/usr/bin/head; G_STAT=/usr/bin/stat; G_LS=/bin/ls; G_ID=/usr/bin/id; G_CAT=/bin/cat; G_MKDIR=/bin/mkdir; audit() { :; }
      . "$KDIR/lib/conf.sh"; tree_check_paths "$g" "$g"; echo "rc=$? why=[$G_TREE_WHY]" ); }
  assert_has "$(r15_lib_paths)" "rc=0 why=\[\]" "positive control: the installed tree passes"
  for p in bin lib lib/heal.sh bin/guardian.sh lib/canary.sh state flags; do
    chmod +a "group:everyone deny delete" "$g/$p"
    assert_has "$(r15_lib_paths)" "rc=1 why=\[.* acl[^]]*: $p\]" "the default deny-delete entry on $p is a finding in strict mode"
    chmod -N "$g/$p"
  done
  assert_has "$(r15_lib_paths)" "rc=0 why=\[\]" "stripped: passes again"
}

# (ii) fixture for the acting tests: an installed tree, a conf, a recorder that is not loaded (so the Guardian acts when it may), fakes first in PATH.
r15_fix() { # <name>
  local d="$T/$1" h="$T/$1/home" n
  mkdir -p "$d/bin" "$d/libexec" "$d/la"
  cat >"$d/bin/launchctl" <<F
#!/bin/bash
echo "\$(/bin/date +%s) launchctl \$*" >>"$d/calls.ts"
case "\$1" in print) exit 113 ;; esac
exit 0
F
  cat >"$d/bin/ioreg" <<'F'
#!/bin/bash
case "$*" in
  *IOUSBHostDevice*) echo "USB Audio C270 HD" ;;
  *IOAudioEngine*) echo "C270 engine" ;;
  *IOHIDSystem*) echo "    | |   \"HIDIdleTime\" = 1000000000000" ;;
esac
F
  cat >"$d/bin/pgrep" <<'F'
#!/bin/bash
case "$*" in *coreaudiod*) echo 9999; exit 0 ;; esac
exit 1
F
  # nothing that makes a sound, opens an app or kills a process can reach the real one from these runs
  for n in afplay open killall say osascript; do printf '#!/bin/bash\necho "%s $*" >>"%s/other.calls"\nexit 0\n' "$n" "$d" >"$d/bin/$n"; done
  chmod +x "$d"/bin/*; : >"$d/calls.ts"
  GUARDIAN_HOME="$h" LA_DIR="$d/la" GUARDIAN_ROOT_HELPER="$d/libexec/eta-guardian-root" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" >/dev/null 2>&1
  {
    printf 'GUARDIAN_ROOM="opd9"\n'
    printf "GUARDIAN_PUBLISH_CMD='cat >>%s/pub.log'\n" "$d"
    printf "GUARDIAN_SUBSCRIBE_CMD='sleep 1013'\n"
    printf "GUARDIAN_CONTROL_SUB_CMD='sleep 1013'\n"
    printf 'GUARDIAN_SUDO=""\nGUARDIAN_ROOT_HELPER="/usr/local/libexec/eta-guardian-root"\nUSB_MIC_PATTERN="C270"\n'
  } >"$h/guardian.conf"
  chmod 600 "$h/guardian.conf"; : >"$d/pub.log"
  GUARDIAN_FAKE_NOW="$(/bin/date +%s)" write_status state=recording poll_age=5
}
# one fresh canonical heal, then one tick (`once`) of the installed copy in production shape; the 3/h cap and the dedupe stamps are cleared first
r15_once() { # <name>
  local d="$T/$1" h="$T/$1/home" rn
  rn="$(/bin/date +%s)"
  rm -rf "$h/state/once" "$h/state/control_latch" "$h/state/control_state" "$h/state/flag_last"; : >"$h/state/actions"
  { printf '%s\n' "$rn"; printf '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$rn"; } >"$h/state/control.last"
  GUARDIAN_FAKE_NOW="$rn" write_status state=recording poll_age=5
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" \
    /bin/bash -p "$h/bin/guardian.sh" once >"$d/once.out" 2>&1
}
r15_acts() { grep -cE 'bootout|bootstrap' "$T/$1/calls.ts"; }

# (ii) a tree loosened between two ticks of a process that is already up is killed by the per-tick check (the live-run test below). A fresh `once` start on a loosened tree is refused by the
# R15b pre-source check instead: exit 3, no act, no health line. Restored = it acts again. One tick (`once`) per step, with a positive control that acts.
test_r15_loosened_tree_means_no_act_no_start_and_restore_acts_again() {
  local d="$T/tt" h="$T/tt/home" a0 a1 a2 sh
  r15_fix tt
  r15_once tt; a0="$(r15_acts tt)"
  [ "$a0" -ge 1 ] && ok || fail "positive control: a clean tree acts (got $a0; $(tail -c 300 "$d/once.out"))"
  assert_has "$(grep '"mode"' "$d/pub.log" | tail -n1)" '"mode":"heal"' "positive control: health says heal"
  for sh in "chmod g+w $h/lib/heal.sh|chmod g-w $h/lib/heal.sh" "chmod +a everyone\ allow\ write $h/bin|chmod -N $h/bin"; do
    : >"$d/pub.log"
    eval "${sh%%|*}"
    r15_once tt; a1="$(r15_acts tt)"
    assert_eq "$a1" "$a0" "${sh%%|*}: no act on the start after the tree was loosened"
    assert_has "$(cat "$d/once.out")" "code tree unsafe" "${sh%%|*}: the pre-source check said so on stderr"
    assert_eq "$(wc -c <"$d/pub.log" | tr -d ' ')" "0" "${sh%%|*}: nothing published (the start was refused)"
    eval "${sh##*|}"
    r15_once tt; a2="$(r15_acts tt)"
    [ "$a2" -gt "$a1" ] && ok || fail "${sh%%|*}: restored, the Guardian acts again (acts $a1 -> $a2)"
    a0="$a2"
  done
}

# (ii) the same on the real run loop: it checks the tree on every pass, before it polls the flag, so a loosened file stops the acts within a tick and a restore resumes them.
test_r15_live_run_loosened_tree_stops_acting_within_a_tick_and_restore_resumes() {
  local h="$T/rtree/home" i=0 t1 t2 p1 p2 n_during n_after
  R15_TREE=1 r13_live_start rtree "$R13_FRESH"
  r13_wait_msg rtree >/dev/null
  while [ "$(r13_mut_count rtree 0)" -lt 1 ] && [ "$i" -lt 40 ]; do sleep 1; i=$((i + 1)); done
  [ "$(r13_mut_count rtree 0)" -ge 1 ] && ok || { fail "positive control: the run acted on a clean tree"; r13_live_stop rtree; return; }
  chmod g+w "$h/lib/heal.sh"; t1="$(/bin/date +%s)"
  sleep 13
  p1="$(wc -l <"$T/rtree/pub.log" | tr -d ' ')"
  sleep 14
  p2="$(wc -l <"$T/rtree/pub.log" | tr -d ' ')"
  n_during="$(r13_mut_count rtree $((t1 + 13)))"
  assert_eq "$n_during" "0" "no mutating call from one tick after the file was loosened"
  [ "$p2" -gt "$p1" ] && ok || fail "health kept flowing while killed (pub.log $p1 -> $p2 lines)"
  assert_has "$(grep -h '"mode"' "$T/rtree/pub.log" | tail -n1)" '"mode":"shadow"' "health says shadow while the tree is loose"
  assert_has "$(cat "$h/audit.log")" "code tree check ok -> bad file writable: lib/heal.sh" "one audit line for the change"
  chmod g-w "$h/lib/heal.sh"; t2="$(/bin/date +%s)"; i=0
  while [ "$(r13_mut_count rtree "$t2")" -lt 1 ] && [ "$i" -lt 45 ]; do sleep 1; i=$((i + 1)); done
  n_after="$(r13_mut_count rtree "$t2")"
  [ "$n_after" -ge 1 ] && ok || fail "restored: the run acts again"
  assert_has "$(cat "$h/audit.log")" "bad file writable: lib/heal.sh -> ok" "and the restore is audited"
  assert_eq "$(grep -c 'code tree check' "$h/audit.log")" "3" "three audit lines in all (start, loosened, restored), none per tick"
  r13_live_stop rtree
}

# N3 (d2 refute, herdr rerun 15): once and handle re-exec under bash -p exactly as run does. This covers the re-exec fallback only (`bash guardian.sh` with a BASH_ENV that does NOT redefine exec());
# a BASH_ENV defining exec() under `bash guardian.sh` is out of the model (README); the shebang and plist entries are tested in test_r15b_shebang_entry_ignores_a_hostile_bash_env. A BASH_ENV that pre-sets readonly USB_DPRIME_HEAL=1 and G_BAD_CONST=
# defeats g_const's tamper check if it is read; under bash -p it is never read. The BASH_ENV file leaves a mark at shell exit, so a run that read it shows.
# Fakes first in PATH, and no control message on disk (the Guardian is killed): nothing here can reach a real recorder, launchd or the log.
test_r15_once_and_handle_ignore_bash_env_like_run_does() {
  local d="$T/n3" h="$T/n3/home" mark="$T/benv.mark" f="$T/benv.rc"
  r15_fix n3
  { echo 'readonly USB_DPRIME_HEAL=1 G_BAD_CONST='; printf "trap 'printf \"%%s dph=%%s bad=[%%s]\\n\" \"\$0\" \"\$USB_DPRIME_HEAL\" \"\$G_BAD_CONST\" >>%s' EXIT\n" "$mark"; } >"$f"
  : >"$mark"
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" BASH_ENV="$f" ENV="$f" \
    /bin/bash "$h/bin/guardian.sh" once >/dev/null 2>&1
  assert_eq "$(grep -c 'guardian.sh' "$mark")" "0" "once: BASH_ENV was not honoured by the shell that ran guardian.sh (no mark from it)"
  assert_has "$(cat "$d/pub.log")" '"mode"' "once: it did run (a health line was published)"
  : >"$d/pub.log"
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" BASH_ENV="$f" ENV="$f" \
    /bin/bash "$h/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 n3" >/dev/null 2>&1
  assert_eq "$(grep -c 'guardian.sh' "$mark")" "0" "handle: BASH_ENV was not honoured (no mark from guardian.sh)"
  assert_has "$(cat "$d/pub.log")" 'opd9' "handle: it did run (the probe answer was published)"
  # an installed tree (no tests/) ignores the test-entry marker too
  : >"$d/pub.log"
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" BASH_ENV="$f" GUARDIAN_TEST_ENTRY=1 \
    /bin/bash "$h/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 n3b" >/dev/null 2>&1
  assert_eq "$(grep -c 'guardian.sh' "$mark")" "0" "an installed tree ignores GUARDIAN_TEST_ENTRY and BASH_ENV"
  # the harness path is unchanged: marker, once|handle and tests/run.sh next to the script (the dev tree) still read the environment
  : >"$d/pub.log"
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" BASH_ENV="$f" GUARDIAN_TEST_ENTRY=1 \
    /bin/bash "$KDIR/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 n3c" >/dev/null 2>&1
  assert_has "$(cat "$mark")" "dph=1 bad=\[\]" "the dev-tree test entry still reads the environment, as the harness needs"
}

# R15b (refute MU2): the order matters. In the run loop the tree check comes before the flag poll and before tick (the act step); in once it comes before the flag fetch and tick; in check before the flag fetch.
test_r15b_tree_check_comes_before_the_act_step_in_every_entry() {
  local g c f t
  g="$(grep -v '^[[:space:]]*#' "$KDIR/bin/guardian.sh")"
  c="$(printf '%s\n' "$g" | grep -n 'tree_check || true   *# R15: before any act path' | head -n1 | cut -d: -f1)"
  f="$(printf '%s\n' "$g" | grep -n '^    flag_poll$' | head -n1 | cut -d: -f1)"
  t="$(printf '%s\n' "$g" | grep -n '^    tick$' | head -n1 | cut -d: -f1)"
  [ -n "$c" ] && [ -n "$f" ] && [ -n "$t" ] && ok || fail "the loop lines were not found (c=$c f=$f t=$t)"
  [ "${c:-999}" -lt "${f:-0}" ] && [ "${f:-999}" -lt "${t:-0}" ] && ok || fail "run loop order: tree_check ($c) < flag_poll ($f) < tick ($t)"
  assert_has "$g" '^  once) tree_check || true; flag_fetch; tick ;;$' "once: tree_check, then flag_fetch, then tick"
  assert_eq "$(printf '%s\n' "$g" | grep -A1 '^  tree_check || true$' | grep -c '^  flag_fetch$')" "1" "check: tree_check directly before flag_fetch"
  # run(): the start-up check comes before the loops are started
  c="$(printf '%s\n' "$g" | grep -n '^  tree_check || true$' | head -n1 | cut -d: -f1)"
  t="$(printf '%s\n' "$g" | grep -n '^  subscriber_loop &$' | head -n1 | cut -d: -f1)"
  [ -n "$c" ] && [ -n "$t" ] && [ "$c" -lt "$t" ] && ok || fail "run start: tree_check ($c) before the loops ($t)"
}

# The tree check is in the agent, once per loop pass, and every path that acts runs it first (static).
test_r15_tree_check_is_wired_into_every_entry() {
  local g; g="$(grep -v '^[[:space:]]*#' "$KDIR/bin/guardian.sh")"
  assert_eq "$(printf '%s\n' "$g" | grep -c 'tree_check || true')" "4" "run start, the loop pass, check, once"
  assert_has "$g" "G_TREE_BAD=1" "run mode starts killed until the check passes"
  assert_has "$(grep -n 'G_TREE_BAD' "$KDIR/lib/killswitch.sh")" "CTRL_WHY=tree" "control_parse says why=tree"
  assert_eq "$(grep -c 'G_TREE_BAD' "$KDIR/lib/killswitch.sh")" "3" "control_parse, the no-control-command branch and killswitch_engaged"
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR/lib/conf.sh" | grep -c -E 'readonly G_TREE_BAD')" "0" "the flag is recomputed every tick, so it is not readonly"
}
