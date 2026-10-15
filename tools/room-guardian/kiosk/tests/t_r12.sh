#!/bin/bash
# R12: guardian.conf is data; safety numbers are constants; run mode reads no test seam.
# Every one of the 27 clock-freeze attacks of the C3 rerun 9 refute (A1..A21, with variants) is a test here, plus the R11 refute cases.
# The harness runs the REAL guardian.sh in production shape: `env -i`, a conf file in GUARDIAN_HOME, the real clock, no GUARDIAN_TEST_ENTRY.
# A message that is 600 s old is on disk (a heal for this room). The correct answer to every attack is "killswitch=engaged mode=shadow".
# shellcheck disable=SC2016,SC2030,SC2031
PROD_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
assert_lit() { case "$1" in *"$2"*) ok ;; *) fail "$3: [$2] not found in [$(printf %s "$1" | head -c 300)]" ;; esac; }

# prod <env k=v ...> -- <guardian.sh args>: production shape. Only HOME, GUARDIAN_HOME and PATH come from the harness.
prod() {
  local envs=() a
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" ${envs[@]+"${envs[@]}"} /bin/bash "$KDIR/bin/guardian.sh" "$@" 2>/dev/null
  a=$?; return "$a"
}

r12_base_conf() {
  cat <<'EOF'
# a normal conf
GUARDIAN_ROOM="opd9"
GUARDIAN_PUBLISH_CMD='{ printf "%s\t" "$1"; cat; } >>"__T__/pub.log"'
GUARDIAN_SUBSCRIBE_CMD='sleep 1'
GUARDIAN_CONTROL_SUB_CMD='sleep 1'
GUARDIAN_SUDO=""
GUARDIAN_ROOT_HELPER="/usr/local/libexec/eta-guardian-root"
USB_MIC_PATTERN="C270"
EOF
}
# r12_write_conf [extra text]: base conf plus extra lines, into GUARDIAN_HOME/guardian.conf
r12_write_conf() {
  mkdir -p "$GUARDIAN_HOME/state"
  { r12_base_conf | sed "s|__T__|$T|g"; [ -z "${1:-}" ] || printf '%s\n' "$1"; } >"$GUARDIAN_HOME/guardian.conf"
  chmod 600 "$GUARDIAN_HOME/guardian.conf"
}
# r12_msg <age s> [room-mode]: control.last received <age> s ago (real clock), canonical heal for opd9 with ts of the same age
r12_msg() {
  local rn recv; rn="$(/bin/date +%s)"; recv=$((rn - $1))
  rm -f "$GUARDIAN_HOME/state/control_latch" "$GUARDIAN_HOME/state/control_state"
  { printf '%s\n' "$recv"; printf '{"kill": false, "modes": {"opd9": "%s"}, "ts": %s}\n' "${2:-heal}" "$recv"; } >"$GUARDIAN_HOME/state/control.last"
}
# r12_hold <label> <conf extra> [env k=v ...]: the attack must leave the agent engaged and in shadow with a 600 s old message
r12_hold() {
  local label="$1" extra="$2" out; shift 2
  r12_write_conf "$extra"; r12_msg 600
  out="$(prod "$@" -- check)"
  assert_has "$out" "killswitch=engaged mode=shadow" "$label: still killed"
}

test_r12_positive_control_fresh_heal_is_clear_and_heal() {
  r12_write_conf ""; r12_msg 5
  assert_has "$(prod -- check)" "killswitch=clear mode=heal" "fresh heal, clean conf"
  r12_msg 600
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=stale" "600 s old = stale"
}

test_r12_90_s_rule_89_clear_91_killed_in_production_shape() {
  r12_write_conf ""; r12_msg 89
  assert_has "$(prod -- check)" "killswitch=clear mode=heal" "89 s"
  r12_msg 91
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=stale" "91 s"
}

# ---- the 27 attacks (C3 rerun 9), conf variants ----
test_r12_attack_testmode_and_fake_now_in_conf() {   # A1, A1b, A18
  local old; old="$(( $(/bin/date +%s) - 600 ))"
  r12_hold "A1 TESTMODE+FAKE_NOW (+export)" "GUARDIAN_TESTMODE=1
GUARDIAN_FAKE_NOW=$old
export GUARDIAN_TESTMODE=1
export GUARDIAN_FAKE_NOW=$old"
  r12_hold "A1b FAKE_NOW only" "GUARDIAN_FAKE_NOW=$old"
  r12_hold "A18 export TESTMODE" "export GUARDIAN_TESTMODE=1"
  r12_hold "R11 refute: _G_TM=1" "_G_TM=1
GUARDIAN_FAKE_NOW=$old"
}
test_r12_attack_readonly_testmode_and_declare() {   # A2, A2b
  local old; old="$(( $(/bin/date +%s) - 600 ))"
  r12_hold "A2 readonly TESTMODE" "readonly GUARDIAN_TESTMODE=1
GUARDIAN_FAKE_NOW=$old"
  r12_hold "A2b declare -rx" "declare -rx GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW=$old"
}
test_r12_attack_planted_date_variable_and_function() {   # A3, A3b, A4, A4b, R11 refute /bin/date()
  local old; old="$(( $(/bin/date +%s) - 600 ))"
  printf '#!/bin/bash\necho %s\n' "$old" >"$T/fakedate"; chmod +x "$T/fakedate"
  r12_hold "A3 readonly G_DATE" "readonly G_DATE=$T/fakedate"
  r12_hold "A3b G_DATE" "G_DATE=$T/fakedate"
  r12_hold "A4 now_epoch() + readonly -f" "now_epoch() { echo $old; }
readonly -f now_epoch"
  r12_hold "A4b now_epoch()" "now_epoch() { echo $old; }"
  r12_hold "R11 refute: /bin/date() function" "/bin/date() { echo $old; }"
}
test_r12_attack_stale_limit_and_non_integers() {   # A5, A6, A6b, A17
  r12_hold "A5 CONTROL_STALE_S=999999999" "CONTROL_STALE_S=999999999"
  r12_hold "A6 CONTROL_STALE_S=never" "CONTROL_STALE_S=never"
  r12_hold "A6b CONTROL_STALE_S='90 -o 1'" "CONTROL_STALE_S='90 -o 1'"
  r12_hold "A17 CONTROL_STALE_S=0x7fffffff" "CONTROL_STALE_S=0x7fffffff"
  r12_hold "skew and caps are not keys" "CONTROL_SKEW_S=999999
CONTROL_MAX_BYTES=999999
FLAG_FETCH_S=999999"
}
test_r12_attack_alias_trap_functrace_builtin_games() {   # A7, A10, A11, A12
  local old; old="$(( $(/bin/date +%s) - 600 ))"
  r12_hold "A7 alias" "shopt -s expand_aliases
alias now_epoch='echo $old'"
  r12_hold "A10 enable -n [ test" "enable -n [ test"
  r12_hold "A11 DEBUG trap + functrace" "set -o functrace
trap 'GUARDIAN_TESTMODE=1; GUARDIAN_FAKE_NOW=$old' DEBUG"
  r12_hold "A12 function [" "function [ { return 0; }"
}
test_r12_attack_path_and_tz_in_conf() {   # A8, A9
  local old; old="$(( $(/bin/date +%s) - 600 ))"
  mkdir -p "$T/fakebin"; printf '#!/bin/bash\necho %s\n' "$old" >"$T/fakebin/date"; chmod +x "$T/fakebin/date"
  r12_hold "A8 PATH with a fake date" "PATH=$T/fakebin:/usr/bin:/bin"
  r12_hold "A9 TZ" "TZ=Pacific/Kiritimati"
}
test_r12_attack_old_flag_command_with_empty_sub_cmd() {   # A16
  r12_write_conf ""
  grep -v 'GUARDIAN_CONTROL_SUB_CMD' "$GUARDIAN_HOME/guardian.conf" >"$T/c2"
  printf 'GUARDIAN_CONTROL_SUB_CMD=\nGUARDIAN_FLAG_CMD='"'"'echo fleet=on; echo mode=heal'"'"'\n' >>"$T/c2"
  cp "$T/c2" "$GUARDIAN_HOME/guardian.conf"; r12_msg 600
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow" "A16 conf FLAG_CMD"
  # the same through the environment, and a clean conf with no control command at all
  r12_write_conf ""; grep -v 'GUARDIAN_CONTROL_SUB_CMD' "$GUARDIAN_HOME/guardian.conf" >"$T/c3"; cp "$T/c3" "$GUARDIAN_HOME/guardian.conf"
  assert_has "$(prod GUARDIAN_FLAG_CMD='echo fleet=on; echo mode=heal' -- check)" "killswitch=engaged mode=shadow" "A16 env FLAG_CMD, no control command"
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=no_control_cmd" "production requires GUARDIAN_CONTROL_SUB_CMD"
  # even with a fresh heal on disk
  r12_msg 1; assert_has "$(prod -- check)" "killswitch=engaged mode=shadow" "no control command = killed, fresh message or not"
}
test_r12_attack_state_dir_and_control_parse_in_conf() {   # A20, A21
  r12_hold "A20 readonly STATE_DIR" "readonly STATE_DIR=$T/elsewhere"
  r12_hold "A21 control_parse() + readonly -f" "control_parse() { CTRL_FLEET=on; CTRL_MODE=heal; CTRL_WHY=ok; return 0; }
readonly -f control_parse"
}

# ---- environment (launchd) variants ----
test_r12_attack_launchd_environment() {   # A13, A13b, A14, A15, A19 and the seams
  local old; old="$(( $(/bin/date +%s) - 600 ))"
  r12_hold "A13 env TESTMODE+FAKE_NOW" "" GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW="$old"
  r12_hold "A13b env FAKE_NOW only" "" GUARDIAN_FAKE_NOW="$old"
  r12_hold "A14 env CONTROL_STALE_S" "" CONTROL_STALE_S=999999999
  r12_hold "env CONTROL_STALE_S=never" "" CONTROL_STALE_S=never
  mkdir -p "$T/fakebin"; printf '#!/bin/bash\necho %s\n' "$old" >"$T/fakebin/date"; chmod +x "$T/fakebin/date"
  r12_hold "A15 env PATH with a fake date" "" PATH="$T/fakebin:$PROD_PATH"
  printf 'GUARDIAN_ROOM="opd9"\nGUARDIAN_CONTROL_SUB_CMD=true\n' >"$T/evil.conf"
  r12_hold "A19 env GUARDIAN_CONF" "" GUARDIAN_CONF="$T/evil.conf"
  r12_hold "env GUARDIAN_TEST_ENTRY=1 does not open check" "" GUARDIAN_TEST_ENTRY=1 GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW="$old"
  r12_hold "env G_RUNMODE=0" "" G_RUNMODE=0 GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW="$old"
  r12_hold "env G_BAD_CONST/G_CONF_BAD cleared" "" G_CONF_BAD=0 G_BAD_CONST= GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW="$old"
  r12_hold "env GUARDIAN_PS" "" GUARDIAN_TESTMODE=1 GUARDIAN_PS=/bin/false
  r12_hold "env tunables (HEAL_MAX_PER_HOUR, FLAG_FETCH_S)" "" HEAL_MAX_PER_HOUR=999 FLAG_FETCH_S=99999 CONTROL_SKEW_S=99999 CONTROL_MAX_BYTES=99999
  r12_hold "env exported function now_epoch" "" 'BASH_FUNC_now_epoch%%=() { echo '"$old"'; }'
}
test_r12_once_and_handle_without_the_test_marker_ignore_the_environment() {
  local old rn out; rn="$(/bin/date +%s)"; old=$((rn - 600))
  r12_write_conf ""
  : >"$T/pub.log"
  prod GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW=5 RR_ROOT="$RR_ROOT" -- handle "kiosk/opd9/probe" "probe opd9 e1" >/dev/null
  out="$(grep -o '"ts":[0-9]*' "$T/pub.log" | head -n1 | cut -d: -f2)"
  [ -n "$out" ] && [ "$out" != "5" ] && ok || fail "handle without the marker used the fake clock: [$out]"
  : >"$T/pub.log"
  prod GUARDIAN_TEST_ENTRY=1 GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW=5 RR_ROOT="$RR_ROOT" -- handle "kiosk/opd9/probe" "probe opd9 e2" >/dev/null
  out="$(grep -o '"ts":[0-9]*' "$T/pub.log" | head -n1 | cut -d: -f2)"
  assert_eq "$out" "5" "with the marker, once|handle honour the test seam (the harness path)"
}

# ---- a bad conf: killed, audited, health still published ----
test_r12_bad_conf_runs_killed_audits_and_keeps_publishing_health() {
  r12_write_conf 'THIS_IS_NOT_A_KEY=1'; r12_msg 1
  mkdir -p "$T/bin"
  local out
  out="$(prod PATH="$T/bin:$PROD_PATH" T="$T" CALLS="$CALLS" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" -- check)"
  assert_has "$out" "killswitch=engaged mode=shadow why=conf" "fresh heal on disk, conf bad: killed"
  : >"$T/pub.log"
  prod PATH="$T/bin:$PROD_PATH" T="$T" CALLS="$CALLS" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" -- once >/dev/null
  assert_has "$(cat "$T/pub.log")" "kiosk/opd9/health" "health still published"
  assert_has "$(cat "$T/pub.log")" '"mode":"shadow"' "and it says shadow"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" 'conf error line=' "the reason is audited"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" 'key not allowed: THIS_IS_NOT_A_KEY' "key name, line number"
  assert_not "$(cat "$CALLS")" "launchctl boot" "no action"
}
test_r12_every_conf_error_kills() {
  local n=0 line out
  while IFS= read -r line; do
    n=$((n + 1))
    r12_write_conf "$line"; r12_msg 1
    out="$(prod -- check)"
    case "$out" in *"killswitch=engaged mode=shadow why=conf"*) ok ;; *) fail "conf line [$line] did not kill: $out" ;; esac
  done <<'EOF'
FOO=bar
guardian_room="x"
GUARDIAN_ROOM="opd9"
GUARDIAN_ROOM="Bad Room"
GUARDIAN_ROOM="a$(id)"
GUARDIAN_ROOM = "x"
GUARDIAN_SUDO="$HOME/sudo"
GUARDIAN_SUDO="`id`"
GUARDIAN_SUDO="sudo -n"; id
GUARDIAN_SUDO=sudo -n
GUARDIAN_ROOT_HELPER="relative/path"
GUARDIAN_ROOT_HELPER="/usr/local/../etc/x"
CANARY_VOLUME=1.5
CANARY_VOLUME=loud
CANARY_VOLUME=0.123
PRESENCE_FILE="rel"
USB_MIC_PATTERN=""
USB_MIC_PATTERN="a;b"
GUARDIAN_PUBLISH_CMD=''
GUARDIAN_PUBLISH_CMD='unterminated
GUARDIAN_PUBLISH_CMD='a''b'
if true; then :; fi
. /etc/profile
source /etc/profile
(cd /; id)
x() { :; }
GUARDIAN_ROOM="opd9" GUARDIAN_SUDO=""
GUARDIAN_ROOM=$HOME
GUARDIAN_ROOM=${HOME}
EOF
  [ "$n" -ge 20 ] && ok || fail "table too short: $n"
}
test_r12_control_bytes_and_size_kill() {
  local out
  r12_write_conf ""; printf 'USB_MIC_PATTERN="C270"\r\n' >>"$GUARDIAN_HOME/guardian.conf"; r12_msg 1
  assert_has "$(prod -- check)" "why=conf" "CR"
  r12_write_conf ""; printf 'USB_MIC_PATTERN="C2\0\0"\n' >>"$GUARDIAN_HOME/guardian.conf"; r12_msg 1
  assert_has "$(prod -- check)" "why=conf" "NUL"
  r12_write_conf ""; printf 'USB_MIC_PATTERN="C2\xc3\xa9"\n' >>"$GUARDIAN_HOME/guardian.conf"; r12_msg 1
  assert_has "$(prod -- check)" "why=conf" "high byte"
  r12_write_conf ""; { printf '# '; head -c 17000 /dev/zero | tr '\0' 'x'; printf '\n'; } >>"$GUARDIAN_HOME/guardian.conf"; r12_msg 1
  assert_has "$(prod -- check)" "why=conf" "file over 16 KiB"
  rm -f "$GUARDIAN_HOME/guardian.conf"; r12_msg 1
  out="$(prod -- check)"
  assert_has "$out" "killswitch=engaged mode=shadow" "no conf at all is killed"
}

# ---- what a good conf may contain ----
conf_parse_in_sub() { # <file> -> prints rc and the final values of the keys given as args
  local f="$1"; shift
  ( . "$KDIR/lib/common.sh"; . "$KDIR/lib/conf.sh"; conf_load "$f"; rc=$?; printf 'rc=%s' "$rc"; for k in "$@"; do printf ' %s=[%s]' "$k" "${!k}"; done )
}
test_r12_accepted_forms_match_the_real_conf_shape() {
  # the shape of a real kiosk conf, with invented values: export of an ssh option string, single-quoted commands that hold $ and double quotes,
  # a double-quoted value with a trailing comment, a bare value, a comment line, blank lines, indentation
  cat >"$T/shape.conf" <<'EOF'
# kiosk conf
GUARDIAN_ROOM="opd9"
export GUARDIAN_PIPE_SSH='-i /k/id -o ConnectTimeout=5 pipe@host'

GUARDIAN_PUBLISH_CMD='ssh $GUARDIAN_PIPE_SSH "pub $1" <&0'
GUARDIAN_SUBSCRIBE_CMD='ssh $GUARDIAN_PIPE_SSH "sub $1" | while read -r l; do printf "%s\n" "$l"; done'
  GUARDIAN_CONTROL_SUB_CMD='ssh $GUARDIAN_PIPE_SSH "sub $2"'
GUARDIAN_SUDO="sudo -n"   # kiosk-local; no sudoers entry yet.
GUARDIAN_ROOT_HELPER="/usr/local/libexec/eta-guardian-root"
USB_MIC_PATTERN="C270"
PRESENCE_FILE=/var/tmp/presence.hb
CANARY_VOLUME=0.3 # soft
EOF
  local out; out="$(conf_parse_in_sub "$T/shape.conf" GUARDIAN_ROOM GUARDIAN_SUDO GUARDIAN_CONTROL_SUB_CMD GUARDIAN_PIPE_SSH CANARY_VOLUME PRESENCE_FILE)"
  assert_lit "$out" "rc=0" "clean"
  assert_lit "$out" 'GUARDIAN_ROOM=[opd9]' "double quoted"
  assert_lit "$out" 'GUARDIAN_SUDO=[sudo -n]' "trailing comment dropped"
  assert_lit "$out" 'GUARDIAN_CONTROL_SUB_CMD=[ssh $GUARDIAN_PIPE_SSH "sub $2"]' "single quotes are literal, indentation allowed"
  assert_lit "$out" 'GUARDIAN_PIPE_SSH=[-i /k/id -o ConnectTimeout=5 pipe@host]' "export key"
  assert_lit "$out" 'CANARY_VOLUME=[0.3]' "bare value with a comment"
  assert_lit "$out" 'PRESENCE_FILE=[/var/tmp/presence.hb]' "bare absolute path"
}
test_r12_example_conf_is_clean_and_has_no_shell_syntax() {
  sed "s/<room-slug>/opd9/" "$KDIR/guardian.conf.example" >"$T/ex.conf"
  assert_lit "$(conf_parse_in_sub "$T/ex.conf" GUARDIAN_ROOM)" "rc=0 GUARDIAN_ROOM=[opd9]" "the example parses clean"
  # the example plus the real key set, uncommented
  sed -e "s/<room-slug>/opd9/" -e "s/^# export GUARDIAN_PIPE_SSH/export GUARDIAN_PIPE_SSH/" -e 's|^# PRESENCE_FILE=.*|PRESENCE_FILE="/var/tmp/p.hb"|' -e 's/^# CANARY_VOLUME/CANARY_VOLUME/' "$KDIR/guardian.conf.example" >"$T/ex2.conf"
  assert_lit "$(conf_parse_in_sub "$T/ex2.conf" GUARDIAN_PIPE_SSH)" "rc=0 GUARDIAN_PIPE_SSH=[<ssh options for the pipe>]" "every allow-listed key in one file"
}
test_r12_conf_is_never_sourced_or_evaluated() {
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR/bin/guardian.sh" "$KDIR"/lib/*.sh | grep -cE '(^|[;&|(]|[[:space:]])(\.|source)[[:space:]]+"?\$\{?(CONF|CONFIG|GUARDIAN_CONF)')" "0" "no source of the conf"
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR/lib/conf.sh" | grep -cE '(^|[^A-Za-z_])(eval|source)[[:space:]]|[[:space:]]\. ')" "0" "no eval or source in the parser"
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR/bin/guardian.sh" | grep -cE '^\. "\$CONF"|\. "\$\{?GUARDIAN_CONF')" "0" "guardian.sh does not dot the conf"
}

# ---- static: no test seam is read without the run-mode gate; no environment default in the libraries ----
test_r12_every_seam_read_is_behind_the_run_mode_gate() {
  local n
  n="$(grep -nE 'GUARDIAN_TESTMODE|GUARDIAN_FAKE_NOW|GUARDIAN_PS' "$KDIR/bin/guardian.sh" "$KDIR"/lib/*.sh | grep -v ':[0-9]*:[[:space:]]*#' | grep -v 'G_RUNMODE' | grep -v '^[^:]*guardian.sh:[0-9]*:  unset ' | grep -vE 'echo "\$GUARDIAN_FAKE_NOW"' | wc -l | tr -d ' ')"
  assert_eq "$n" "0" "every TESTMODE / FAKE_NOW / PS read carries the G_RUNMODE check"
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR"/lib/*.sh | grep -cE '\$\{(CONTROL_STALE_S|CONTROL_SKEW_S|CONTROL_MAX_BYTES|FLAG_FETCH_S)[:=-]')" "0" "no environment default for a safety number"
  assert_eq "$(grep -hE '^: "\$\{' "$KDIR"/lib/*.sh | grep -vcE 'GUARDIAN_HOME|RR_ROOT|RR_LABEL|RR_PLIST|RR_APP')" "0" "the libraries use g_def, not :=, for everything but the paths"
}
test_r12_safety_numbers_are_readonly_constants() {
  local out
  out="$( . "$KDIR/lib/common.sh"; if ( CONTROL_STALE_S=999 ) 2>/dev/null; then echo assigned; else echo -n "refused "; fi; echo "$CONTROL_STALE_S $CONTROL_SKEW_S $CONTROL_MAX_BYTES $CONTROL_LINE_MAX $FLAG_FETCH_S" )"
  assert_eq "$out" "refused 90 30 4096 4200 10" "constants, and an assignment after load does not change them"
  out="$( CONTROL_STALE_S=5 CONTROL_SKEW_S=1 FLAG_FETCH_S=1 CONTROL_MAX_BYTES=1 G_RUNMODE=1; . "$KDIR/lib/common.sh"; echo "$CONTROL_STALE_S $CONTROL_SKEW_S $CONTROL_MAX_BYTES $FLAG_FETCH_S" )"
  assert_eq "$out" "90 30 4096 10" "the environment cannot set them, run mode or not"
  out="$( CONTROL_STALE_S=5; . "$KDIR/lib/common.sh"; echo "$CONTROL_STALE_S" )"
  assert_eq "$out" "90" "library tests do not get a settable stale limit either"
  out="$( readonly CONTROL_STALE_S=999999; . "$KDIR/lib/common.sh"; echo "bad=${G_BAD_CONST:-none}" )"
  assert_eq "$out" "bad=1" "a stale limit made readonly beforehand is detected"
  assert_eq "$(grep -c 'readonly -f' "$KDIR/bin/guardian.sh")" "1" "functions readonly in run mode"
}
test_r12_run_mode_functions_are_readonly() {
  # the loop that marks every function readonly runs before the dispatcher, and only in run mode
  assert_has "$(sed -n '/^# Run mode: every function is readonly/,/^fi/p' "$KDIR/bin/guardian.sh")" "readonly -f" "marks every function readonly"
  assert_has "$(sed -n '/^# Run mode: every function is readonly/,/^fi/p' "$KDIR/bin/guardian.sh")" 'G_RUNMODE:-}" = 1' "only in run mode"
  # a function replaced after the preamble is refused: simulate by running check in a shell that tries it after sourcing nothing (readonly -f semantic)
  assert_eq "$(bash -c 'f() { echo a; }; readonly -f f; f() { echo b; } 2>/dev/null; f')" "a" "readonly -f keeps the first definition"
}

# ---- the shipped files ----
test_r12_plist_runs_bash_p_and_sets_only_guardian_home() {
  local p; p="$(cat "$KDIR/launchd/com.evenscribe.room-guardian.plist.tmpl")"
  assert_has "$p" "<string>-p</string>" "bash -p: no BASH_ENV, no exported functions, no SHELLOPTS"
  assert_eq "$(printf '%s\n' "$p" | sed -n '/EnvironmentVariables/,/<\/dict>/p' | grep -c '<key>[A-Z_]*</key><string>')" "1" "one environment variable"
  assert_eq "$(printf '%s\n' "$p" | sed -n '/EnvironmentVariables/,/<\/dict>/p' | grep -c 'GUARDIAN_HOME')" "1" "and it is GUARDIAN_HOME"
  plutil -lint "$KDIR/launchd/com.evenscribe.room-guardian.plist.tmpl" >/dev/null 2>&1; assert_rc $? 0 "plist is well formed"
  assert_has "$p" "cannot change the safety constants\|is ignored" "documented in the plist"
}
test_r12_install_copies_every_lib_and_rejects_a_bad_config() {
  rm -rf "$GUARDIAN_HOME"
  GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" >/dev/null
  local f
  for f in "$KDIR"/lib/*.sh; do
    [ -f "$GUARDIAN_HOME/lib/${f##*/}" ] && ok || fail "lib ${f##*/} not installed"
  done
  [ -f "$GUARDIAN_HOME/lib/canary.sh" ] && [ -f "$GUARDIAN_HOME/lib/conf.sh" ] && ok || fail "canary.sh and conf.sh installed"
  # the stub conf the installer writes is itself a clean conf
  assert_lit "$(conf_parse_in_sub "$GUARDIAN_HOME/guardian.conf" GUARDIAN_ROOM)" "rc=0 GUARDIAN_ROOM=[opd9]" "installed stub parses"
  # a --config the agent would reject is refused before anything is installed
  printf 'GUARDIAN_ROOM="opd9"\nFOO=1\n' >"$T/bad.conf"
  rm -rf "$GUARDIAN_HOME"
  GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --config "$T/bad.conf" --sudo "$T/bin/fakesudo" >/dev/null 2>&1
  assert_rc $? 2 "bad --config refused"
  [ ! -e "$GUARDIAN_HOME/guardian.conf" ] && ok || fail "nothing installed from a bad config"
  printf 'GUARDIAN_ROOM="opd9"\nGUARDIAN_CONTROL_SUB_CMD='"'"'true'"'"'\n' >"$T/good.conf"
  GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --config "$T/good.conf" --sudo "$T/bin/fakesudo" >/dev/null 2>&1
  assert_rc $? 0 "good --config accepted"
}
test_r12_installed_tree_runs_the_check() {
  rm -rf "$GUARDIAN_HOME"
  GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" >/dev/null
  r12_msg 5
  local out; out="$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" /bin/bash -p "$GUARDIAN_HOME/bin/guardian.sh" check 2>&1)"
  assert_has "$out" "killswitch=" "the installed copy (with conf.sh and canary.sh) starts"
}

# ---- the live run: a wedged subscriber ----
# The real guardian.sh run, real clock, production shape. The control subscriber delivers ONE canonical heal and then wedges (it prints nothing more).
# A persistent fault (recorder not running) makes the Guardian act while the heal is fresh. From +91 s of the message no mutating call may happen.
test_r12_live_wedged_subscriber_no_action_after_91_s() {
  local fl="$T/calls.ts" t0 tmsg i mut_before mut_after hl
  cat >"$T/bin/launchctl" <<'F'
#!/bin/bash
echo "$(/bin/date +%s) launchctl $*" >>"$T/calls.ts"
case "$1" in print) exit 113 ;; esac
exit 0
F
  chmod +x "$T/bin/launchctl"
  : >"$T/rec_pid"
  GUARDIAN_FAKE_NOW="$(/bin/date +%s)" write_status state=recording poll_age=5
  r12_write_conf ""
  cat >"$T/ctlsub.sh" <<'F'
#!/bin/bash
echo $$ >>"$T/ctl.pid"
printf '{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\n' "$(/bin/date +%s)"
exec sleep 400
F
  printf '#!/bin/bash\necho $$ >>"$T/sub.pid"\nexec sleep 400\n' >"$T/sub.sh"
  chmod +x "$T/ctlsub.sh" "$T/sub.sh"
  {
    r12_base_conf | sed "s|__T__|$T|g" | grep -v 'GUARDIAN_CONTROL_SUB_CMD\|GUARDIAN_SUBSCRIBE_CMD'
    printf "GUARDIAN_SUBSCRIBE_CMD='T=%s /bin/bash %s/sub.sh'\n" "$T" "$T"
    printf "GUARDIAN_CONTROL_SUB_CMD='T=%s /bin/bash %s/ctlsub.sh'\n" "$T" "$T"
  } >"$GUARDIAN_HOME/guardian.conf"
  : >"$fl"; rm -f "$GUARDIAN_HOME/state/control.last"
  /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$T/bin:$PROD_PATH" T="$T" CALLS="$CALLS" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" \
    /bin/bash "$KDIR/bin/guardian.sh" run >"$T/run.out" 2>&1 &
  echo $! >"$T/main.pid"
  t0="$(/bin/date +%s)"
  i=0; while [ ! -s "$GUARDIAN_HOME/state/control.last" ] && [ "$i" -lt 30 ]; do sleep 0.5; i=$((i + 1)); done
  tmsg="$(/usr/bin/head -n1 "$GUARDIAN_HOME/state/control.last" 2>/dev/null)"
  [ -n "$tmsg" ] && ok || { fail "no control message arrived"; return; }
  # wait until 93 s after the message
  while [ "$(( $(/bin/date +%s) - tmsg ))" -lt 93 ]; do sleep 1; done
  mut_before="$(awk -v t="$tmsg" '$1 <= t + 90' "$fl" | grep -cE 'bootout|bootstrap')"
  [ "$mut_before" -ge 1 ] && ok || fail "positive control: the Guardian acted while the heal was fresh (got $mut_before)"
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=stale" "check at +93 s"
  # two more ticks and a bit
  while [ "$(( $(/bin/date +%s) - tmsg ))" -lt 125 ]; do sleep 1; done
  mut_after="$(awk -v t="$tmsg" '$1 > t + 91' "$fl" | grep -cE 'bootout|bootstrap')"
  assert_eq "$mut_after" "0" "no mutating launchctl call after +91 s"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "unreachable:stale" "audit shows the stale transition"
  hl="$(grep 'kiosk/opd9/health' "$T/pub.log" | tail -n 1)"
  assert_has "$hl" '"mode":"shadow"' "health after +91 s says shadow"
  kill -0 "$(cat "$T/main.pid")" 2>/dev/null && ok || fail "the Guardian itself is still running (it did not exit to stop acting)"
  kill "$(cat "$T/main.pid")" 2>/dev/null; wait "$(cat "$T/main.pid")" 2>/dev/null
}
