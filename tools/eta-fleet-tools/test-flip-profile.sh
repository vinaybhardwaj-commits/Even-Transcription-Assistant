#!/bin/bash
# test-flip-profile.sh -- offline test of flip-0111.sh's Chrome profile check and --profile flag.
# Runs a COPY of the script in a temp dir against stub ssh / security / helper .mjs files: no network, no host, no
# keychain, no Neon. Stub ssh decodes the root script flip-0111.sh sends and answers by what it asks for.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/flip-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }
has() { case "$2" in *"$3"*) ok ;; *) bad "$1: expected '$3' in:"; printf '%s\n' "$2" | sed 's/^/    | /' ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1: must NOT contain '$3'" ;; *) ok ;; esac; }
eq() { [ "$2" = "$3" ] && ok || bad "$1: expected '$3' got '$2'"; }

bash -n "$HERE/flip-0111.sh" && ok || bad "bash -n flip-0111.sh"

mkdir -p "$T/bin" "$T/tools" "$T/home"
cp "$HERE/flip-0111.sh" "$T/tools/flip-0111.sh"
printf 'console.log("nobody");\n' > "$T/tools/occ-check.mjs"
printf 'console.log("latest 2026-10-06T00:00:00Z 0.1.1.39");\n' > "$T/tools/ext-check.mjs"
echo "postgres://fake" > "$T/dburl"; echo "fake key" > "$T/key"; chmod 600 "$T/key"

cat > "$T/bin/security" <<'STUB'
#!/bin/bash
case " $* " in *" -w "*) echo "fake-password" ;; esac
exit 0
STUB
cat > "$T/bin/ssh" <<'STUB'
#!/bin/bash
cmd="${@: -1}"
case "$cmd" in
  true) exit 0 ;;
  curl\ -sS*) echo "<updatecheck codebase='x' version='${FAKE_SERVED:-0.1.1.39}'/>"; exit 0 ;;
  'u=$(stat -f %Su /dev/console)'*) printf 'kiosk\n501\n'; exit 0 ;;
esac
if printf '%s' "$cmd" | grep -q 'base64 -D'; then
  cat >/dev/null   # the password on stdin
  b64=$(printf '%s' "$cmd" | sed -n "s/.*printf %s '\([^']*\)'.*/\1/p")
  script=$(printf '%s' "$b64" | base64 -D)
  { echo "=== script"; printf '%s\n' "$script"; } >> "$FAKE_LOG"
  case "$script" in
    *"echo PRINT_RC"*) printf 'PRINT_RC=0\nPLIST=yes\n' ;;
    *"CENSUS_DONE"*)
      case "$script" in *"profile.last_used"*)
        echo "LAST_USED=$FAKE_LAST"; echo "ACTIVE=$FAKE_ACTIVE"
        IFS=, read -ra ds <<< "$FAKE_DIRS"; for d in "${ds[@]}"; do [ -n "$d" ] && echo "PROFDIR=$d"; done
        echo PROFILE_READ_DONE ;; esac
      printf '%s\n' "${FAKE_CENSUS-CENSUS|Default|present|0.1.1.39_0}"; echo CENSUS_DONE ;;
    *"profile.last_used"*)
      echo "LAST_USED=$FAKE_LAST"; echo "ACTIVE=$FAKE_ACTIVE"
      IFS=, read -ra ds <<< "$FAKE_DIRS"; for d in "${ds[@]}"; do [ -n "$d" ] && echo "PROFDIR=$d"; done
      echo PROFILE_READ_DONE ;;
    *"chrome_stop()"*) printf '%s\n' "${FAKE_REPAIR_OUT:-}"; exit "${FAKE_REPAIR_RC:-0}" ;;
    *"repair-aside"*) printf '%s\n' "${FAKE_RESTORE_OUT:-GUARD=LOADED}" ;;
    *"launchctl bootout"*) echo "STATE=STILL_LOADED" ;;
  esac
  exit 0
fi
exit 0
STUB
chmod +x "$T/bin/security" "$T/bin/ssh"

run() { # run <last> <active json> <dirs csv> <flip args...>: prints output then "rc=N"
  local last="$1" active="$2" dirs="$3"; shift 3
  : > "$T/fake.log"
  HOME="$T/home" PATH="$T/bin:$PATH" ETA_DB_URL_FILE="$T/dburl" FAKE_LOG="$T/fake.log" \
    FAKE_LAST="$last" FAKE_ACTIVE="$active" FAKE_DIRS="$dirs" \
    bash "$T/tools/flip-0111.sh" --legacy-flip "$@" EHRC-TEST-Mac kiosk@host.invalid svc-test "$T/key" 2>&1
  echo "rc=$?"
}
fakelog() { cat "$T/fake.log"; }

# 1. Guest Profile as last_used -> exit 11, profile list printed, nothing changed
out="$(run 'Guest Profile' '["Guest Profile"]' 'Default,Guest Profile')"
has "guest: exit 11" "$out" "rc=11"
has "guest: reason" "$out" "GUEST_OR_NO_PROFILE"
has "guest: profile list printed" "$out" "profiles on EHRC-TEST-Mac: Default,Guest Profile"
hasnt "guest: guard never touched" "$(fakelog)" "launchctl bootout"
hasnt "guest: no chrome relaunch" "$(fakelog)" "open -a"

# 2. no active profile at all (null values read as empty)
out="$(run '' '' 'Default')"
has "no profile: exit 11" "$out" "rc=11"
has "no profile: reason" "$out" "no active Chrome profile"
hasnt "no profile: guard never touched" "$(fakelog)" "launchctl bootout"
out="$(run '<null>' '' '')"
has "null last_used, no dirs: exit 11" "$out" "rc=11"
has "no dirs: list says none" "$out" "profiles on EHRC-TEST-Mac: none"

# 3. a normal profile passes the check and the run goes on to step ii (the stub then fails the bootout: exit 6)
out="$(run 'Default' '["Default"]' 'Default,Profile 1')"
has "default: past the check" "$out" "rc=6"
has "default: reached step ii" "$(fakelog)" "launchctl bootout"
hasnt "default: no abort 11" "$out" "GUEST_OR_NO_PROFILE"
# active list empty but last_used set: last_used is the active profile
out="$(run 'Profile 1' '[]' 'Default,Profile 1')"
has "empty active, last_used set: passes" "$out" "rc=6"
# pretty-printed JSON array (plutil multi-line) is flattened on the host by tr; the Air still parses it
out="$(run 'Default' '[  "Default",  "Profile 1"]' 'Default,Profile 1')"
has "two active: passes" "$out" "active=[Default,Profile 1]"

# 4. --profile: named profile must exist; it overrides the Guest abort
out="$(run 'Guest Profile' '["Guest Profile"]' 'Default,Profile 1,Guest Profile' --profile "Profile 1")"
has "--profile with guest last_used: passes" "$out" "rc=6"
has "--profile logged" "$out" "using --profile 'Profile 1'"
out="$(run 'Default' '["Default"]' 'Default' --profile "Profile 9")"
has "--profile missing on host: exit 11" "$out" "rc=11"
has "--profile missing: reason" "$out" "--profile 'Profile 9' not found"
hasnt "--profile missing: guard never touched" "$(fakelog)" "launchctl bootout"
out="$(run 'Default' '["Default"]' 'Default,Profile 1' --profile=Default)"
has "--profile=VALUE form" "$out" "rc=6"

# 5. bad --profile values are refused before anything runs
for badp in 'a/b' "x'y" '..' '.' '../x' 'a;b' '$(id)'; do
  out="$(run 'Default' '["Default"]' 'Default' --profile "$badp")"
  has "bad profile '$badp'" "$out" "rc=1"
  has "bad profile '$badp' message" "$out" "bad --profile"
done
out="$(HOME="$T/home" bash "$T/tools/flip-0111.sh" --profile 2>&1; echo "rc=$?")"
has "--profile without a value" "$out" "--profile needs a directory name"; has "--profile without a value rc" "$out" "rc=1"

# 6. dry-run: --profile reaches STEP iii and STEP vi as --profile-directory; without it no flag appears
dry() { HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/tools/flip-0111.sh" --dry-run --legacy-flip "$@" EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?"; }
out="$(dry --profile "Profile 1")"
has "dry-run rc" "$out" "rc=0"
eq "dry-run: profile flag appears in iii and vi (and in the one summary line)" "$(printf '%s\n' "$out" | grep -v 'Chrome will be started' | grep -c -- "--profile-directory=Profile 1")" "2"
has "dry-run: iii line" "$(printf '%s' "$out" | tr -s ' ')" "open -a \"Google Chrome\" --args '--profile-directory=Profile 1'"
has "dry-run: vi line" "$out" "\"https://pulse.even.in/\" --args '--profile-directory=Profile 1'"
has "dry-run: profile read step shown" "$out" "profile.last_used"
has "dry-run: only the two keys" "$out" "profile.last_active_profiles"
hasnt "dry-run: no other Chrome data read" "$(printf '%s\n' "$out" | sed 's/Managed Preferences//g')" "Preferences"
hasnt "dry-run: no Cookies" "$out" "Cookies"
out="$(dry)"
has "dry-run without flag rc" "$out" "rc=0"
hasnt "dry-run without flag: no --profile-directory in a command" "$(printf '%s\n' "$out" | grep -v 'Chrome will be started')" "--profile-directory"
has "dry-run: says no flag" "$out" "no --profile-directory"

# 7. usage text mentions the flag and exit 11
out="$(bash "$T/tools/flip-0111.sh" --help 2>&1)"
has "help: --profile" "$out" "--profile"
has "help: exit 11" "$out" "11 GUEST_OR_NO_PROFILE"

# 8. G2(a): MODE=remove only deletes 0.1.0.14* when another version dir of the same id is there. The inner script is taken
#    from the OPD 1 dry-run output and run against a fake Chrome dir.
EXTID="choegfgddhpljibnolbcljnlfhfpimbh"
inner="$(HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/tools/flip-0111.sh" --dry-run --legacy-flip EHRC-CONSUL2s-Mac-mini-2 kiosk@host.invalid svc-test 2>&1 \
  | sed -n "/^ *| cd \"\$ROOT\"/,/^ *| echo \"DONE \$MODE\"/p" | sed 's/^ *| //')"
has "purge: inner script found in OPD 1 dry-run" "$inner" 'DONE $MODE'
mkfake() { # fresh fake Chrome dir at $T/chrome: P1 old+new, P2 old only, P3 two old only, P4 new only, P5 old+new+dotfile
  rm -rf "$T/chrome"; local r="$T/chrome" e="Extensions/$EXTID"
  mkdir -p "$r/P1/$e/0.1.0.14_0" "$r/P1/$e/0.1.1.39_0" "$r/P1/Service Worker" \
           "$r/P2/$e/0.1.0.14_0" "$r/P2/Service Worker" \
           "$r/P3/$e/0.1.0.14_0" "$r/P3/$e/0.1.0.145_0" \
           "$r/P4/$e/0.1.1.39_0" "$r/P4/Service Worker" \
           "$r/P5/$e/0.1.0.14_0" "$r/P5/$e/0.1.1.39_0"
  : > "$r/P5/$e/.DS_Store"
}
purge() { (cd "$T" && MODE="$1" EXT="$EXTID" ROOT="$T/chrome" bash -c "$inner" 2>&1); }
mkfake; out="$(purge list)"
has "list: P1 stale dir listed" "$out" "chrome/P1/Extensions/$EXTID/0.1.0.14_0"
has "list: P2 flagged only-version" "$out" "KEPT_ONLY_VERSION $T/chrome/P2/Extensions/$EXTID/0.1.0.14_0"
hasnt "list: nothing removed" "$out" "REMOVED"
[ -d "$T/chrome/P1/Extensions/$EXTID/0.1.0.14_0" ] && ok || bad "list removed a dir"
mkfake; out="$(purge remove)"
[ ! -d "$T/chrome/P1/Extensions/$EXTID/0.1.0.14_0" ] && ok || bad "remove: P1 old dir should be gone"
[ -d "$T/chrome/P1/Extensions/$EXTID/0.1.1.39_0" ] && ok || bad "remove: P1 new dir must stay"
[ ! -d "$T/chrome/P1/Service Worker" ] && ok || bad "remove: P1 Service Worker goes with the removed dir"
[ -d "$T/chrome/P2/Extensions/$EXTID/0.1.0.14_0" ] && ok || bad "remove: P2 only version must be kept"
[ -d "$T/chrome/P2/Service Worker" ] && ok || bad "remove: P2 Service Worker must stay (nothing removed)"
has "remove: P2 reported" "$out" "KEPT_ONLY_VERSION $T/chrome/P2/Extensions/$EXTID/0.1.0.14_0"
[ -d "$T/chrome/P3/Extensions/$EXTID/0.1.0.14_0" ] && [ -d "$T/chrome/P3/Extensions/$EXTID/0.1.0.145_0" ] && ok || bad "remove: P3 two old dirs, no other version: both kept"
[ -d "$T/chrome/P4/Service Worker" ] && ok || bad "remove: P4 (no old dir) Service Worker untouched"
[ ! -d "$T/chrome/P5/Extensions/$EXTID/0.1.0.14_0" ] && ok || bad "remove: P5 old dir gone (new dir beside a dotfile)"
[ -n "$(ls -A "$T/chrome/P1/Extensions/$EXTID")" ] && ok || bad "remove: an id dir was left empty"
for pr in P1 P2 P3 P4 P5; do [ -n "$(ls "$T/chrome/$pr/Extensions/$EXTID")" ] && ok || bad "remove: $pr id dir empty"; done
has "remove: DONE" "$out" "DONE remove"

# 9. G2(b): --repair
out="$(HOME="$T/home" bash "$T/tools/flip-0111.sh" --legacy-flip --repair EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "--legacy-flip + --repair refused" "$out" "cannot be combined with --repair"; has "--legacy-flip + --repair rc" "$out" "rc=1"
out="$(HOME="$T/home" bash "$T/tools/flip-0111.sh" --skip-uninstall EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "--skip-uninstall without --legacy-flip refused" "$out" "legacy flow"; has "--skip-uninstall without --legacy-flip rc" "$out" "rc=1"
out="$(HOME="$T/home" bash "$T/tools/flip-0111.sh" --legacy-flip --census EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "--legacy-flip + --census refused" "$out" "rc=1"
out="$(HOME="$T/home" bash "$T/tools/flip-0111.sh" --census --all-open-profiles EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "--census + --all-open-profiles refused" "$out" "read-only"
out="$(HOME="$T/home" bash "$T/tools/flip-0111.sh" --repair --check --profile Default EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "repair + --check refused" "$out" "rc=1"
out="$(bash "$T/tools/flip-0111.sh" --help 2>&1)"; has "help: --repair" "$out" "--repair"
rdry() { HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/tools/flip-0111.sh" --dry-run --repair --profile "Profile 1" EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?"; }
out="$(rdry)"
has "repair dry-run rc" "$out" "rc=0"
has "repair dry-run: single root script with trap" "$out" "trap cleanup EXIT"
has "repair dry-run: guard bootout" "$out" 'launchctl bootout "system/$GLABEL"'
has "repair dry-run: plist moved aside" "$out" 'mv -f "$MP" "$ASIDE"'
has "repair dry-run: cfprefsd flush" "$out" "killall cfprefsd"
has "repair dry-run: profile passed quoted" "$out" "PROF=Profile\\ 1"
has "repair dry-run: verify line" "$out" "0.1.1.39_0"
eq "repair dry-run: exactly one root shell after the pre-checks" "$(printf '%s\n' "$out" | grep -c 'chrome_stop()')" "1"
hasnt "repair dry-run: no flip steps" "$out" "STEP iii"
rscript() { # the repair root script exactly as the host would run it (from the stub-ssh log)
  sed -n '/^=== script/,$p' "$T/fake.log" | awk '/^=== script/{n++} {print > ("'"$T"'/scr." n)}'
  for f in "$T"/scr.*; do grep -q 'chrome_stop()' "$f" && { sed 1d "$f"; return; }; done
}
rrun() { # rrun <repair out> <rc> [restore out]; env REPAIR=...: prints output + rc
  : > "$T/fake.log"; rm -f "$T"/scr.*
  printf 'console.log("latest 2026-10-06T10:00:00Z 0.1.1.39");console.log("target 2026-10-06T10:00:05Z 0.1.1.39");\n' > "$T/tools/ext-check.mjs"
  HOME="$T/home" PATH="$T/bin:$PATH" ETA_DB_URL_FILE="$T/dburl" FAKE_LOG="$T/fake.log" FAKE_REPAIR_OUT="$1" FAKE_REPAIR_RC="$2" FAKE_RESTORE_OUT="${3:-GUARD=LOADED}" \
    FAKE_LAST="${FAKE_LAST:-Default}" FAKE_ACTIVE="${FAKE_ACTIVE:-[\"Default\"]}" FAKE_DIRS="${FAKE_DIRS:-Default,Profile 1}" FAKE_CENSUS="${FAKE_CENSUS-}" \
    bash "$T/tools/flip-0111.sh" --repair --profile "Profile 1" EHRC-TEST-Mac kiosk@host.invalid svc-test "$T/key" 2>&1
  echo "rc=$?"
}
out="$(rrun $'REPAIR_GUARD_STOPPED=1\nUNINSTALLED=1\nREPAIR_PLIST_RESTORED=1\nGUARD=LOADED\nINSTALLED=1' 0)"
has "repair ok: rc 0" "$out" "rc=0"
has "repair ok: RESULT line" "$out" "installed and heartbeat seen at 2026-10-06T10:00:05Z"
hasnt "repair ok: no flip step ran" "$(fakelog)" "pkill -TERM -x \"Google Chrome\"; for i in 1 2 3 4 5"
out="$(rrun $'GUARD=LOADED\nINSTALLED=0' 0)"
has "repair: not installed -> exit 7" "$out" "rc=7"
out="$(rrun $'REPAIR_PLIST_ASIDE=1\nGUARD=NOT_LOADED\nINSTALLED=1' 0 'GUARD=NOT_LOADED')"
has "repair: guard not loaded, restore also fails -> rc 10 (GUARD LEFT STOPPED)" "$out" "rc=10"
has "repair: abort ran the restore script" "$out" "repair aborted: restoring the managed plist and the guard"
out="$(rrun $'REPAIR_ERR=no_profile' 1)"
has "repair: profile missing -> exit 11" "$out" "rc=11"
hasnt "repair: profile missing -> no restore needed" "$out" "repair aborted"
out="$(rrun $'REPAIR_PLIST_ASIDE=1' 1 'GUARD=LOADED')"
has "repair: script failure rc 6" "$out" "rc=6"
has "repair: script failure restores plist and guard first" "$out" "repair aborted: restoring"
printf 'console.log("present Dr X");\n' > "$T/tools/occ-check.mjs"
out="$(rrun $'INSTALLED=1' 0)"
has "repair: occupied host -> exit 4" "$out" "rc=4"
hasnt "repair: occupied host never gets the repair script" "$(fakelog)" "chrome_stop()"
printf 'process.exit(3);\n' > "$T/tools/occ-check.mjs"
out="$(rrun $'INSTALLED=1' 0)"
has "repair: occupancy unknown -> exit 4" "$out" "rc=4"
hasnt "repair: occupancy unknown never gets the repair script" "$(fakelog)" "chrome_stop()"
printf 'console.log("nobody");\n' > "$T/tools/occ-check.mjs"
# real execution of the repair script against stubs: plist aside/restore, trap on a signal, guard re-bootstrap
rrun $'GUARD=LOADED\nINSTALLED=1' 0 >/dev/null
RS="$(rscript)"
bash -n <(printf '%s\n' "$RS") && ok || bad "repair script: bash -n"
has "repair script: bound by printf %q header" "$RS" "CU=kiosk CUID=501 PROF=Profile\\ 1"
SB="$T/sb"; rm -rf "$SB"; mkdir -p "$SB/bin" "$SB/home/Library/Application Support/Google/Chrome/Profile 1/Extensions/$EXTID/0.1.0.14_0" "$SB/mp" "$SB/aside"
echo POLICY > "$SB/mp/com.google.Chrome.plist"
for c in sleep killall pgrep; do printf '#!/bin/bash\nexit %s\n' "$([ $c = pgrep ] && echo 1 || echo 0)" > "$SB/bin/$c"; done
printf '#!/bin/bash\necho "NFSHomeDirectory: %s"\n' "$SB/home" > "$SB/bin/dscl"
cat > "$SB/bin/pkill" <<'STUB'
#!/bin/bash
[ -n "${KILL_SELF:-}" ] && kill -TERM "$PPID"
exit 0
STUB
cat > "$SB/bin/launchctl" <<'STUB'
#!/bin/bash
echo "launchctl $*" >> "$SB/calls"
case "$1" in
  bootout)   rm -f "$SB/loaded" ;;
  bootstrap) touch "$SB/loaded" ;;
  print)     [ -f "$SB/loaded" ]; exit $? ;;
  asuser)    E="$SB/home/Library/Application Support/Google/Chrome/Profile 1/Extensions/$EXTID"
             if [ -f "$SB/mp/com.google.Chrome.plist" ]; then mkdir -p "$E/0.1.1.39_0"; else rm -rf "$E"/*; fi ;;
esac
exit 0
STUB
chmod +x "$SB/bin/"*
runrs() { # runrs [env...]: run the repair script with stubs; MP and aside dir point into the sandbox
  touch "$SB/loaded"; : > "$SB/calls"
  { printf 'CU=kiosk CUID=501 PROF=%q EXT=%s TV=0.1.1.39 GLABEL=com.eta.presence-guard GPLIST=/x MP=%q ASIDE_DIR=%q\n' "Profile 1" "$EXTID" "$SB/mp/com.google.Chrome.plist" "$SB/aside"
    printf '%s\n' "$RS" | sed 1d | sed 's#case "$HOMEDIR" in /Users/?\*)#case "$HOMEDIR" in *)#'; } > "$SB/repair.sh"
  env SB="$SB" EXTID="$EXTID" PATH="$SB/bin:$PATH" "$@" bash "$SB/repair.sh" 2>&1
}
out="$(runrs)"
has "repair run: INSTALLED=1" "$out" "INSTALLED=1"
has "repair run: UNINSTALLED=1" "$out" "UNINSTALLED=1"
has "repair run: guard back" "$out" "GUARD=LOADED"
[ "$(cat "$SB/mp/com.google.Chrome.plist")" = POLICY ] && ok || bad "repair run: plist content restored"
[ ! -e "$SB/aside/com.google.Chrome.plist.repair-aside" ] && ok || bad "repair run: aside copy left behind"
[ -d "$SB/home/Library/Application Support/Google/Chrome/Profile 1/Extensions/$EXTID/0.1.1.39_0" ] && ok || bad "repair run: new version dir present"
has "repair run: bootout before bootstrap" "$(grep -n 'bootout\|bootstrap' "$SB/calls" | tr '\n' ' ')" "bootout"
out="$(runrs KILL_SELF=1)"
[ "$(cat "$SB/mp/com.google.Chrome.plist" 2>/dev/null)" = POLICY ] && ok || bad "repair signal: trap must restore the plist"
[ ! -e "$SB/aside/com.google.Chrome.plist.repair-aside" ] && ok || bad "repair signal: aside copy left behind"
has "repair signal: guard re-bootstrapped by the trap" "$(cat "$SB/calls")" "bootstrap system"
[ -f "$SB/loaded" ] && ok || bad "repair signal: guard not loaded after the trap"
# a stale aside copy from a crashed run is put back before anything else
echo STALE > "$SB/aside/com.google.Chrome.plist.repair-aside"; rm -f "$SB/mp/com.google.Chrome.plist"
out="$(runrs)"
has "repair run: stale aside noticed" "$out" "REPAIR_STALE_ASIDE=1"
# F3: the guard is bootstrapped only after the install relaunch
echo POLICY > "$SB/mp/com.google.Chrome.plist"; out="$(runrs)"
last_asuser=$(grep -n '^launchctl asuser' "$SB/calls" | tail -1 | cut -d: -f1); first_boot=$(grep -n '^launchctl bootstrap' "$SB/calls" | head -1 | cut -d: -f1)
[ -n "$last_asuser" ] && [ -n "$first_boot" ] && [ "$first_boot" -gt "$last_asuser" ] && ok || bad "repair: guard bootstrap ($first_boot) must come after the install relaunch ($last_asuser)"
has "repair run: Chrome started through open -a (LaunchServices)" "$(grep '^launchctl asuser' "$SB/calls" | head -1)" "open -a Google Chrome --args --profile-directory=Profile 1 https://pulse.even.in/"
# F2: ssh channel drops (SIGPIPE) mid-run: plist back, cfprefsd flushed, guard bootstrapped
echo POLICY > "$SB/mp/com.google.Chrome.plist"; rm -f "$SB/aside"/*; touch "$SB/loaded"; : > "$SB/calls"
env SB="$SB" EXTID="$EXTID" PATH="$SB/bin:$PATH" bash "$SB/repair.sh" 2>/dev/null | { read -r _l; exit 0; }
sleep 1
[ "$(cat "$SB/mp/com.google.Chrome.plist" 2>/dev/null)" = POLICY ] && ok || bad "SIGPIPE: plist not restored"
[ -f "$SB/loaded" ] && ok || bad "SIGPIPE: guard not bootstrapped"
has "SIGPIPE: cfprefsd flushed" "$(cat "$SB/calls" 2>/dev/null; echo)" "bootstrap system"

# 10. FLIP_TARGET_VER (0.1.1.40 rollout): the served-version gate, the repair verify path and ext-check follow it
out="$(FLIP_TARGET_VER=0.1.1.40 HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/tools/flip-0111.sh" --dry-run EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "target override: dry-run rc 0" "$out" "rc=0"
has "target override: served-version gate names 0.1.1.40" "$out" "must be 0.1.1.40"
hasnt "target override: no 0.1.1.39 gate left" "$out" "must be 0.1.1.39"
out="$(FLIP_TARGET_VER=0.1.1.40 HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/tools/flip-0111.sh" --dry-run --repair --profile "Profile 1" EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1)"
has "target override: repair script carries TV=0.1.1.40" "$out" "TV=0.1.1.40"
out="$(HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/tools/flip-0111.sh" --dry-run EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1)"
has "default target is still 0.1.1.39" "$out" "must be 0.1.1.39"
check_ext="$(grep -c "process.env.FLIP_TARGET_VER" "$HERE/ext-check.mjs")"
eq "ext-check.mjs reads FLIP_TARGET_VER" "$check_ext" "1"

# 11. repair is the default path; --census; --all-open-profiles
printf 'import fs from "node:fs";\nconst f = process.env.FAKE_OCC_COUNT; let n = 0; try { n = +fs.readFileSync(f, "utf8"); } catch (e) {}\nn++; fs.writeFileSync(f, String(n));\nconsole.log(n > +(process.env.FAKE_OCC_AFTER || 1e9) ? "present Dr X" : "nobody");\n' > "$T/tools/occ-check.mjs"
drun() { # drun <flip args...>: default (non-legacy) flip; env FAKE_* from the caller; prints output then rc
  : > "$T/fake.log"; rm -f "$T/occ.count"; printf 'console.log("latest 2026-10-06T10:00:00Z 0.1.1.40");console.log("target 2026-10-06T10:00:05Z 0.1.1.40");\n' > "$T/tools/ext-check.mjs"
  HOME="$T/home" PATH="$T/bin:$PATH" ETA_DB_URL_FILE="$T/dburl" FAKE_LOG="$T/fake.log" FAKE_OCC_COUNT="$T/occ.count" FLIP_TARGET_VER=0.1.1.40 FAKE_SERVED=0.1.1.40 \
    FAKE_REPAIR_OUT="${FAKE_REPAIR_OUT-$'REPAIR_PLIST_RESTORED=1\nGUARD=LOADED\nINSTALLED=1'}" FAKE_REPAIR_RC=0 \
    bash "$T/tools/flip-0111.sh" "$@" EHRC-TEST-Mac kiosk@host.invalid svc-test "$T/key" 2>&1
  echo "rc=$?"
}
profs() { grep -o '^CU=kiosk CUID=501 PROF=[^ ]*\(\\ [^ ]*\)\? ' "$T/fake.log" | sed 's/^CU=kiosk CUID=501 PROF=//; s/\\ / /; s/ $//' | paste -sd, -; }
nscripts() { grep -c 'chrome_stop()' "$T/fake.log"; }
export FAKE_LAST=Default FAKE_ACTIVE='["Default"]' FAKE_DIRS="Default,Profile 1,Profile 5,Profile 7"
out="$(drun)"
has "default: repair path without any flag (rc 0)" "$out" "rc=0"
has "default: repairs the active profile from Local State profile.last_used" "$out" "repairing the active profile 'Default'"
eq "default: the repair script was sent once for Default" "$(profs)" "Default"
hasnt "default: no legacy step ran" "$(fakelog)" "launchctl bootout system/com.eta.presence-guard; echo bootout_rc"
has "default: RESULT line names the repaired profile" "$out" "repair Default | 0.1.1.40 installed and heartbeat seen"
out="$(FAKE_LAST="Profile 1" FAKE_ACTIVE='["Profile 1"]' drun)"
eq "default: last_used 'Profile 1' -> repairs Profile 1" "$(profs)" "Profile 1"
out="$(FAKE_LAST="" FAKE_ACTIVE='["Profile 1","Default"]' drun)"
eq "default: no last_used -> first active profile" "$(profs)" "Profile 1"
out="$(FAKE_LAST="Guest Profile" FAKE_ACTIVE='["Guest Profile"]' drun)"
has "default: Guest last_used -> exit 11" "$out" "rc=11"; eq "default: Guest -> no repair script sent" "$(nscripts)" "0"
out="$(FAKE_LAST="" FAKE_ACTIVE='[]' drun)"
has "default: no active profile at all -> exit 11" "$out" "rc=11"; eq "default: none -> no repair script sent" "$(nscripts)" "0"
out="$(FAKE_LAST="Profile 99" FAKE_ACTIVE='["Profile 99"]' drun)"
has "default: last_used names a missing directory -> exit 11" "$out" "rc=11"; eq "default: missing dir -> no repair script sent" "$(nscripts)" "0"
out="$(drun --profile "Profile 5")"
eq "default: --profile wins over last_used" "$(profs)" "Profile 5"
out="$(drun --profile "Profile 42")"
has "default: --profile missing on the host -> exit 11" "$out" "rc=11"
out="$(HOME="$T/home" PATH="$T/bin:$PATH" FLIP_TARGET_VER=0.1.1.40 bash "$T/tools/flip-0111.sh" --dry-run EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "default dry-run: rc 0" "$out" "rc=0"; has "default dry-run: placeholder for the profile from Local State" "$out" "last_used from Local State"
has "default dry-run: one repair root script" "$out" "chrome_stop()"
hasnt "default dry-run: no legacy STEP iii" "$out" "STEP iii"
out="$(drun --legacy-flip --skip-uninstall)"
has "--legacy-flip: the old flow still runs (step ii)" "$(fakelog)" "launchctl bootout system/com.eta.presence-guard; echo bootout_rc"
eq "--legacy-flip: no repair script" "$(nscripts)" "0"

# census (read-only)
CENSUS=$'CENSUS|Default|present|0.1.1.39_0\nCENSUS|Profile 5|present|0.1.0.33_0\nCENSUS|Profile 7|empty|\nCENSUS|Profile 9|present|0.1.1.40_0\nCENSUS|Profile 11|absent|\nCENSUS|Profile 12|present|0.1.0.14_0,0.1.1.40_0\nCENSUS|Profile 13|present|0.1.1.9_0\nCENSUS|Profile 14|present|0.1.2.0_0\nCENSUS|Profile 15|present|Temp\nCENSUS|Profile 16|present|0.1.1.39_0,Temp\nCENSUS|Profile 17|present|ext.crx,0.1.1.40_0'
out="$(FAKE_CENSUS="$CENSUS" drun --census)"
has "census: rc 0" "$out" "rc=0"
has "census: header with last_used and target" "$out" "census EHRC-TEST-Mac (console kiosk) target 0.1.1.40: last_used='Default'"
has "census: active profile marked and stale" "$out" "* Default"; has "census: Default stale" "$(printf '%s\n' "$out" | grep ' Default ')" "STALE"
has "census: old version stale" "$(printf '%s\n' "$out" | grep 'Profile 5 ')" "STALE"
has "census: empty dir listed as empty and stale" "$(printf '%s\n' "$out" | grep 'Profile 7 ')" "empty"
has "census: empty dir stale" "$(printf '%s\n' "$out" | grep 'Profile 7 ')" "STALE"
has "census: target version present = CURRENT" "$(printf '%s\n' "$out" | grep 'Profile 9 ')" "CURRENT"
has "census: no extension dir = NONE" "$(printf '%s\n' "$out" | grep 'Profile 11 ')" "NONE"
has "census: old + target side by side = CURRENT" "$(printf '%s\n' "$out" | grep 'Profile 12 ')" "CURRENT"
has "census: 0.1.1.9 < 0.1.1.40 numerically (stale)" "$(printf '%s\n' "$out" | grep 'Profile 13 ')" "STALE"
has "census: 0.1.2.0 >= 0.1.1.40 (current)" "$(printf '%s\n' "$out" | grep 'Profile 14 ')" "CURRENT"
has "census: only non-numeric entries (Temp) -> STALE" "$(printf '%s\n' "$out" | grep 'Profile 15 ')" "STALE"
has "census: old version beside Temp -> STALE" "$(printf '%s\n' "$out" | grep 'Profile 16 ')" "STALE"
has "census: stray file beside the target version -> CURRENT" "$(printf '%s\n' "$out" | grep 'Profile 17 ')" "CURRENT"
has "census: stale count" "$out" "6 stale profile(s)"
for w in launchctl 'mv ' 'rm ' killall pkill 'kill ' bootout chrome_stop 'sed -i' '>>' ' > /'; do hasnt "census: script has no '$w'" "$(fakelog)" "$w"; done
eq "census: no occupancy check, no repair script" "$([ -e "$T/occ.count" ] && echo ran || echo none)|$(nscripts)" "none|0"
out="$(FAKE_CENSUS="$CENSUS" HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/tools/flip-0111.sh" --census --dry-run EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "census dry-run: rc 0 and prints the script" "$out" "CENSUS_DONE"

# --all-open-profiles
FAKE_CENSUS="$CENSUS"; export FAKE_CENSUS
out="$(drun --all-open-profiles)"
has "all-open: rc 0" "$out" "rc=0"
eq "all-open: stale profiles first, the active one last (Profile 9/11/12/13/14 are not stale... Profile 13 is)" "$(profs)" "Profile 5,Profile 7,Profile 13,Profile 15,Profile 16,Default"
has "all-open: census decision logged" "$out" "stale profiles to repair besides 'Default': Profile 5 Profile 7 Profile 13 Profile 15 Profile 16"
has "all-open: RESULT lists every repaired profile" "$out" "repair Profile 5, Profile 7, Profile 13, Profile 15, Profile 16, Default |"
eq "all-open: occupancy checked before the first change and before each later profile (2 + 5)" "$(cat "$T/occ.count")" "7"
out="$(FAKE_OCC_AFTER=2 drun --all-open-profiles)"
has "all-open: occupied before the 2nd profile -> exit 4" "$out" "rc=4"
eq "all-open: only the first profile was repaired" "$(profs)" "Profile 5"
has "all-open: says what was repaired and what was left alone" "$out" "repaired so far: Profile 5; not repaired (left alone): Profile 7 Profile 13 Profile 15 Profile 16 Default"
has "all-open: stop message" "$out" "remaining profiles untouched"
FAKE_CENSUS=$'CENSUS|Default|present|0.1.1.39_0\nCENSUS|Profile 9|present|0.1.1.40_0'
out="$(drun --all-open-profiles)"
eq "all-open: nothing else stale -> only the active profile" "$(profs)" "Default"
FAKE_CENSUS="$CENSUS"
out="$(HOME="$T/home" PATH="$T/bin:$PATH" FLIP_TARGET_VER=0.1.1.40 bash "$T/tools/flip-0111.sh" --dry-run --all-open-profiles EHRC-TEST-Mac kiosk@host.invalid svc-test 2>&1; echo "rc=$?")"
has "all-open dry-run: rc 0" "$out" "rc=0"; has "all-open dry-run: says what it would do" "$out" "every profile except the active one whose extension dir is STALE"
unset FAKE_CENSUS FAKE_LAST FAKE_ACTIVE FAKE_DIRS
out="$(bash "$T/tools/flip-0111.sh" --help 2>&1)"
has "help: --census" "$out" "--census"; has "help: --all-open-profiles" "$out" "--all-open-profiles"; has "help: --legacy-flip" "$out" "--legacy-flip"

echo "flip profile tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
