#!/bin/bash
# R15 (Fable gate G14-3 i, ii; the d2 refute N3): the code tree and every ancestor of it, at install and at run time; once/handle under bash -p.
# All of it sandboxed: GUARDIAN_HOME, HOME and the helper path live under $T. Nothing here touches the real EvenScribe directory, a kiosk, launchd or the log.
# Needs t_r12.sh's helpers (prod, r12_write_conf, r12_msg, r13_live_start and friends) and t_r14.sh's (r14_acl_lines).
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154

r15_inst() { GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" "$@"; }
# the INSTALLED copy, in production shape (env -i, bash -p, the real clock), capped like prod
r15_agent() { "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" /bin/bash -p "$GUARDIAN_HOME/bin/guardian.sh" "$@" 2>/dev/null; }
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
  assert_has "$(r15_agent check)" "killswitch=engaged mode=shadow why=tree" "symlink: the agent is killed"
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

# A root-owned writable ancestor is refused (nothing created); --dry-run says so and still creates nothing. /tmp is a real root-owned sticky world-writable directory.
test_r15_a_root_owned_writable_ancestor_is_refused_and_nothing_is_installed() {
  local g="/tmp/r15-refuse-$$-$RANDOM/Guardian" out
  out="$(GUARDIAN_HOME="$g" r15_inst 2>&1)"; assert_rc $? 2 "install into a root-owned writable ancestor: rc 2"
  assert_has "$out" "refusing: ancestor" "says which"
  [ ! -e "${g%/Guardian}" ] && ok || fail "nothing was created under /tmp"
  out="$(GUARDIAN_HOME="$g" r15_inst --dry-run 2>&1)"; assert_rc $? 2 "dry-run reports the refusal with rc 2"
  assert_has "$out" "DRY-RUN: would refuse: ancestor" "dry-run says would refuse"
  [ ! -e "${g%/Guardian}" ] && ok || fail "dry-run created nothing"
  [ ! -e "$T/libexec/eta-guardian-root" ] && [ ! -e "$HOME/Library/LaunchAgents/com.evenscribe.room-guardian.plist" ] && ok || fail "no helper and no plist were installed"
  # only if the refusal failed: remove the directory this test itself named (random, ours)
  case "${g%/Guardian}" in /tmp/r15-refuse-*) [ ! -e "${g%/Guardian}" ] || rm -rf "${g%/Guardian}" ;; esac
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
  assert_has "$(r15_agent check)" "why=tree" "a symlinked code file: the agent is killed"
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

# (ii) the code tree loosened after install: killed at the next check, restored = clear. Each shape, one at a time.
test_r15_loosened_code_tree_kills_the_agent_and_restoring_it_clears() {
  local g sh out
  r15_ready; g="$GUARDIAN_HOME"
  assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "positive control"
  for sh in "g+w lib/heal.sh" "o+w bin/guardian.sh" "g+w lib/common.sh" "g+w lib/conf.sh" "g+w lib/killswitch.sh" "g+w lib/canary.sh" "g+w lib" "o+w bin" "g+w ."; do
    chmod "${sh%% *}" "$g/${sh#* }"
    out="$(r15_agent check)"; assert_has "$out" "killswitch=engaged mode=shadow" "$sh: killed"
    chmod "$(printf '%s' "${sh%% *}" | tr '+' '-')" "$g/${sh#* }"; r12_msg 5
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "$sh: restored, clear"
  done
  for sh in bin lib lib/heal.sh bin/guardian.sh lib/faulttree.sh lib/probe.sh lib/collect.sh; do
    chmod +a "everyone allow write,append" "$g/$sh"
    assert_has "$(r15_agent check)" "killswitch=engaged mode=shadow why=tree" "ACL on $sh: killed"
    assert_has "$(tail -n1 "$g/state/tree_state")" "acl" "ACL on $sh: the reason is acl"
    chmod -N "$g/$sh"; r12_msg 5
    assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "ACL on $sh stripped: clear"
  done
  # an older install has no canary.sh: still clear (the tick skips it)
  mv "$g/lib/canary.sh" "$T/canary.moved"
  assert_has "$(r15_agent check)" "killswitch=clear mode=heal" "no canary.sh: clear"
  mv "$T/canary.moved" "$g/lib/canary.sh"
  # one audit line per state change, not per tick
  : >"$g/audit.log"; chmod g+w "$g/lib/heal.sh"
  r15_agent check >/dev/null; r15_agent check >/dev/null; r15_agent check >/dev/null
  assert_eq "$(grep -c 'code tree check' "$g/audit.log")" "1" "three checks in the bad state: one audit line"
  chmod g-w "$g/lib/heal.sh"
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

# (ii) "agent goes killed within one tick, no act, health still flows; restoring it clears": one tick (`once`) per step, with a positive control that acts.
test_r15_loosened_tree_means_no_act_health_still_flows_and_restore_clears() {
  local d="$T/tt" h="$T/tt/home" a0 a1 a2 sh
  r15_fix tt
  r15_once tt; a0="$(r15_acts tt)"
  [ "$a0" -ge 1 ] && ok || fail "positive control: a clean tree acts (got $a0; $(tail -c 300 "$d/once.out"))"
  assert_has "$(grep '"mode"' "$d/pub.log" | tail -n1)" '"mode":"heal"' "positive control: health says heal"
  for sh in "chmod g+w $h/lib/heal.sh|chmod g-w $h/lib/heal.sh" "chmod +a everyone\ allow\ write $h/bin|chmod -N $h/bin"; do
    : >"$d/pub.log"
    eval "${sh%%|*}"
    r15_once tt; a1="$(r15_acts tt)"
    assert_eq "$a1" "$a0" "${sh%%|*}: no act on the tick after the tree was loosened"
    assert_has "$(grep '"mode"' "$d/pub.log" | tail -n1)" '"mode":"shadow"' "${sh%%|*}: health still flows, in shadow"
    assert_has "$(cat "$h/state/tree_state")" "^bad" "${sh%%|*}: the state file says bad"
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

# N3 (d2 refute, herdr rerun 15): once and handle re-exec under bash -p exactly as run does. A BASH_ENV that pre-sets readonly USB_DPRIME_HEAL=1 and G_BAD_CONST=
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

# The tree check is in the agent, once per loop pass, and every path that acts runs it first (static).
test_r15_tree_check_is_wired_into_every_entry() {
  local g; g="$(grep -v '^[[:space:]]*#' "$KDIR/bin/guardian.sh")"
  assert_eq "$(printf '%s\n' "$g" | grep -c 'tree_check || true')" "4" "run start, the loop pass, check, once"
  assert_has "$g" "G_TREE_BAD=1" "run mode starts killed until the check passes"
  assert_has "$(grep -n 'G_TREE_BAD' "$KDIR/lib/killswitch.sh")" "CTRL_WHY=tree" "control_parse says why=tree"
  assert_eq "$(grep -c 'G_TREE_BAD' "$KDIR/lib/killswitch.sh")" "3" "control_parse, the no-control-command branch and killswitch_engaged"
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR/lib/conf.sh" | grep -c -E 'readonly G_TREE_BAD')" "0" "the flag is recomputed every tick, so it is not readonly"
}
