#!/bin/bash
# R16 hardening (R15B refute S1, N1): the pre-source owner rule and the CDPATH-proof HERE. Sandboxed. Needs t_r12.sh's and t_r15.sh's helpers (r15_ready, r15_pre, R14_CAP).
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154

# S1: bin/guardian.sh pre-source owner rule. A file owned by neither root nor this uid is hard-linked (same volume, no root) over lib/probe.sh.
# The only link made is $GUARDIAN_HOME/lib/probe.sh; it is removed by that exact name (rm of a link never touches the other name).
r16_foreign_file() { # prints the first candidate: a regular, world-readable file on the Data volume owned by a uid that is not 0 and not this uid
  local f me; me="$(/usr/bin/id -u)"
  for f in /var/db/nsurlstoraged/dafsaData.bin /var/db/softwareupdate/journal.plist /var/db/factory_installs/SecondPartyApplicationsManifest.plist; do
    [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || continue
    case "$(/usr/bin/stat -f '%u' "$f" 2>/dev/null)" in ''|0|"$me") continue ;; esac
    echo "$f"; return 0
  done
  return 1
}
test_r16_pre_source_owner_rule_refuses_a_foreign_owned_hard_linked_lib() {
  local g f out
  r15_ready; g="$GUARDIAN_HOME"
  assert_has "$(r15_pre check)" "rc=0 .*killswitch=clear mode=heal" "positive control: a clean tree starts"
  f="$(r16_foreign_file)" || { echo "  SKIP test_r16_pre_source_owner_rule: no foreign-owned file on the Data volume to hard-link (S1 is NOT evidenced on this box)"; return 0; }
  rm -f "$g/lib/probe.sh"
  if ! ln "$f" "$g/lib/probe.sh" 2>"$T/ln.err"; then
    echo "  SKIP test_r16_pre_source_owner_rule: cannot hard-link $f ($(head -c 120 "$T/ln.err")) (S1 is NOT evidenced on this box)"
    return 0
  fi
  out="$(r15_pre check)"
  assert_has "$out" "rc=3 out=\[\] err=\[guardian: code tree unsafe (owner: .*/Guardian/lib/probe.sh)" "foreign-owned probe.sh: exit 3, reason owner, names the file"
  assert_not "$out" "killswitch=" "nothing ran past the pre-source check"
  rm -f "$g/lib/probe.sh"   # exact name: removes only our link, the system file keeps its other name
  [ -e "$f" ] && ok || fail "the system file must still exist after the link is removed"
}

# N1: HERE is computed with CDPATH cleared and symlinks resolved. A relative start (`bash -p bin/guardian.sh`) with CDPATH naming a decoy tree that has a bin/
# must still resolve to the real tree: with the old `cd "bin/.."`, CDPATH made cd land in (and print) the decoy.
test_r16_relative_start_with_a_decoy_cdpath_resolves_the_real_tree() {
  local g out decoy="$T/decoy"
  r15_ready; g="$GUARDIAN_HOME"
  mkdir -p "$decoy" && cp -R "$g/bin" "$g/lib" "$decoy/"
  printf '%s\n' "printf 'DECOY\\n' >>\"$T/decoy.mark\"" >>"$decoy/lib/common.sh"
  : >"$T/decoy.mark"
  out="$(cd "$g" && "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" CDPATH="$decoy" /bin/bash -p bin/guardian.sh check 2>&1)"
  assert_has "$out" "killswitch=clear mode=heal" "relative start, decoy CDPATH: the real tree answers"
  assert_eq "$(wc -c <"$T/decoy.mark" | tr -d ' ')" "0" "the decoy lib was never sourced"
  assert_eq "$(printf '%s' "$out" | grep -c "$decoy")" "0" "the decoy path appears nowhere in the output"
}

# N3: the root helper starts under bash -p, like guardian.sh (no BASH_ENV, no imported function, even when entered through the shebang).
test_r16_root_helper_shebang_is_bash_p() {
  assert_eq "$(head -n1 "$KDIR/bin/guardian-root.sh")" "#!/bin/bash -p" "guardian-root.sh shebang"
  assert_eq "$(head -n1 "$KDIR/bin/guardian.sh")" "#!/bin/bash -p" "guardian.sh shebang (the match)"
}
