#!/bin/bash
# R12: guardian.conf is data; safety numbers are constants; run mode reads no test seam.
# Every one of the 27 clock-freeze attacks of the C3 rerun 9 refute (A1..A21, with variants) is a test here, plus the R11 refute cases.
# The harness runs the REAL guardian.sh in production shape: `env -i`, a conf file in GUARDIAN_HOME, the real clock, no GUARDIAN_TEST_ENTRY.
# A message that is 600 s old is on disk (a heal for this room). The correct answer to every attack is "killswitch=engaged mode=shadow".
# shellcheck disable=SC2016,SC2030,SC2031
PROD_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
assert_lit() { case "$1" in *"$2"*) ok ;; *) fail "$3: [$2] not found in [$(printf %s "$1" | head -c 300)]" ;; esac; }

# prod <env k=v ...> -- <guardian.sh args>: production shape. Only HOME, GUARDIAN_HOME and PATH come from the harness.
# R14 A5: every production-shape call is capped (a perl alarm survives the exec), so a broken gate fails (rc 142) instead of hanging.
R14_CAP=(/usr/bin/perl -e 'alarm shift; exec @ARGV' 60)
prod() {
  local envs=() a
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" ${envs[@]+"${envs[@]}"} /bin/bash "$KDIR/bin/guardian.sh" "$@" 2>/dev/null
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

# ---- the live runs (R13): the real guardian.sh run, real clock, production shape ----
# r13_live_start <name> <ctl-body> [env k=v ...]: one real `run` in its own GUARDIAN_HOME ($T/<name>/home). The control command is the shell text <ctl-body>
# (a conf data line, single-quoted). A persistent fault (recorder not running) makes the Guardian act while the feed is fresh; the fake launchctl logs every call
# with its epoch in $T/<name>/calls.ts. The 3/h action cap is defeated by a helper that empties the actions file every 2 s.
r13_live_start() {
  local name="$1" body="$2" d="$T/$1" h; shift 2
  h="$d/home"; mkdir -p "$d/bin" "$h/state"
  # R15: R15_TREE=1 runs the Guardian from an installed-shape copy of the code under $h (bin/, lib/) instead of the checkout, so a test can loosen that tree
  local entry="$KDIR/bin/guardian.sh"
  if [ -n "${R15_TREE:-}" ]; then
    mkdir -p "$h/bin" "$h/lib"; cp -p "$KDIR/bin/guardian.sh" "$h/bin/"; cp -p "$KDIR"/lib/*.sh "$h/lib/"
    chmod 700 "$h"; chmod -R go-w "$h/bin" "$h/lib"; entry="$h/bin/guardian.sh"
  fi
  cat >"$d/bin/launchctl" <<F
#!/bin/bash
echo "\$(/bin/date +%s) launchctl \$*" >>"$d/calls.ts"
case "\$1" in print) exit 113 ;; esac
exit 0
F
  # a fixed idle HID and a present mic, so the result does not depend on whether someone is using the machine the suite runs on
  cat >"$d/bin/ioreg" <<'F'
#!/bin/bash
case "$*" in
  *IOUSBHostDevice*) echo "USB Audio C270 HD" ;;
  *IOAudioEngine*) echo "C270 engine" ;;
  *IOHIDSystem*) echo "    | |   \"HIDIdleTime\" = 1000000000000" ;;
esac
F
  # no browser, no tape writer, a coreaudiod: nothing on the host the suite runs on can hold the heal back
  cat >"$d/bin/pgrep" <<'F'
#!/bin/bash
case "$*" in *coreaudiod*) echo 9999; exit 0 ;; esac
exit 1
F
  # R15: nothing that makes a sound, opens an app or kills a process by name can reach the real one from a live run
  local n
  for n in afplay open killall say osascript; do printf '#!/bin/bash\necho "%s $*" >>"%s/other.calls"\nexit 0\n' "$n" "$d" >"$d/bin/$n"; done
  chmod +x "$d/bin/launchctl" "$d/bin/ioreg" "$d/bin/pgrep" "$d/bin/afplay" "$d/bin/open" "$d/bin/killall" "$d/bin/say" "$d/bin/osascript"
  : >"$d/calls.ts"
  printf '%s\n' "$body" >"$d/ctl.sh"
  # R14 A5: R14_PLANT = a script body planted as `sleep` in the PATH the Guardian itself is started with (the fakes' bin dir is first in that PATH)
  if [ -n "${R14_PLANT:-}" ]; then printf '%s\n' "$R14_PLANT" >"$d/bin/sleep"; chmod +x "$d/bin/sleep"; fi
  {
    printf 'GUARDIAN_ROOM="opd9"\n'
    printf "GUARDIAN_PUBLISH_CMD='cat >>%s/pub.log'\n" "$d"
    printf "GUARDIAN_SUBSCRIBE_CMD='sleep 1013'\n"
    case "$body" in
      RAW:*) printf "GUARDIAN_CONTROL_SUB_CMD='%s'\n" "${body#RAW:}" ;;   # R14 A5: the conf command is run directly, no wrapper script
      *) printf "GUARDIAN_CONTROL_SUB_CMD='/bin/bash -p %s/ctl.sh'\n" "$d" ;;
    esac
    printf 'GUARDIAN_SUDO=""\nGUARDIAN_ROOT_HELPER="/usr/local/libexec/eta-guardian-root"\nUSB_MIC_PATTERN="C270"\n'
  } >"$h/guardian.conf"
  chmod 600 "$h/guardian.conf"
  GUARDIAN_FAKE_NOW="$(/bin/date +%s)" write_status state=recording poll_age=5
  ( exec /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$d/bin:$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" "$@" \
      /bin/bash -p "$entry" run >"$d/run.out" 2>&1 ) &
  echo $! >"$d/main.pid"
  # keep the 3/h cap from ending the run of actions early
  ( while :; do : >"$h/state/actions"; /bin/sleep 2; done ) &
  echo $! >"$d/cap.pid"
}
r13_live_stop() { # <name>...
  local n p
  for n in "$@"; do
    for p in "$T/$n/main.pid" "$T/$n/cap.pid"; do kill "$(cat "$p" 2>/dev/null)" 2>/dev/null; done
  done
  wait 2>/dev/null
}
r13_msg_epoch() { /usr/bin/head -n1 "$T/$1/home/state/control.last" 2>/dev/null; }
r13_mut_count() { # <name> <from-epoch-exclusive> [to-epoch-inclusive]: bootout/bootstrap calls in the window
  awk -v a="$2" -v b="${3:-99999999999}" '$1 > a && $1 <= b' "$T/$1/calls.ts" | grep -cE 'bootout|bootstrap'
}
# one legit canonical heal, then the transport wedges. The sleep is NOT exec'd, so an exported function or a BASH_ENV file named sleep would take over.
R13_WEDGE='printf "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\n" "$(/bin/date +%s)"
sleep 1000'
# a feed that never stops: one fresh canonical heal every 5 s (the positive control)
R13_FRESH='while :; do printf "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\n" "$(/bin/date +%s)"; /bin/sleep 5; done'
R13_FORGE='() { if [ "$1" = 1000 ]; then while :; do printf "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\n" "$(/bin/date +%s)"; command sleep 5; done; else command sleep "$@"; fi; }'

r13_wait_msg() { # <name>: wait for the first control message; prints its receive epoch
  local i=0
  while [ ! -s "$T/$1/home/state/control.last" ] && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
  r13_msg_epoch "$1"
}
r13_wait_until() { local t="$1"; while [ "$(( $(/bin/date +%s) - t ))" -lt "$2" ]; do sleep 1; done; }

# S3. The wedged transport must stop acting at +91 s. The run can fail: the 3/h cap is defeated (the actions file is emptied every 2 s), and a run with a
# fresh feed (positive control) must still act after +91 s, so "no action" cannot come from the cap or a dead harness.
test_r12_live_wedged_subscriber_no_action_after_91_s() {
  local tw tf before after fresh_after
  r13_live_start wedge "$R13_WEDGE"
  r13_live_start fresh "$R13_FRESH"
  tw="$(r13_wait_msg wedge)"; tf="$(r13_wait_msg fresh)"
  [ -n "$tw" ] && [ -n "$tf" ] && ok || { fail "no control message arrived"; r13_live_stop wedge fresh; return; }
  r13_wait_until "$tw" 93
  before="$(r13_mut_count wedge 0 $((tw + 90)))"
  [ "$before" -ge 1 ] && ok || fail "wedge: the Guardian acted while the heal was fresh (got $before; tw=$tw; $(grep -o '"reason":"[a-z_]*"[^}]*"result":"[^"]*"' "$T/wedge/home/audit.log" | cut -c1-160 | tail -n4 | tr "\n" "|"))"
  assert_has "$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$T/wedge/home" PATH="$PROD_PATH" /bin/bash -p "$KDIR/bin/guardian.sh" check 2>/dev/null)" "killswitch=engaged mode=shadow why=stale" "wedge: check at +93 s"
  r13_wait_until "$tw" 125
  after="$(r13_mut_count wedge $((tw + 91)))"
  assert_eq "$after" "0" "wedge: no mutating launchctl call after +91 s"
  fresh_after="$(r13_mut_count fresh $((tw + 91)))"
  [ "$fresh_after" -ge 1 ] && ok || fail "positive control: the fresh-feed run did not act after +91 s (got $fresh_after): the harness cannot tell"
  assert_has "$(cat "$T/wedge/home/audit.log")" "unreachable:stale" "wedge: audit shows the stale transition"
  assert_has "$(grep -h '"mode"' "$T/wedge/pub.log" 2>/dev/null | tail -n 1)" '"mode":"shadow"' "wedge: health after +91 s says shadow"
  kill -0 "$(cat "$T/wedge/main.pid")" 2>/dev/null && ok || fail "the Guardian itself is still running (it did not exit to stop acting)"
  r13_live_stop wedge fresh
}

# M1 (R14 A5). The refuter's repro: the control command is `sleep 1000` itself, run directly, and an exported function or a BASH_ENV file named sleep forges a
# fresh heal feed when it reaches the child. With the clean environment the real sleep runs: no message ever arrives, the switch stays engaged, 0 mutating calls.
# The test must fail when `env -i` is taken out of g_conf_cmd (the gate shows that mutation run).
test_r13_live_env_injection_into_the_transport_child_is_inert() {
  local i a b c nf nb np ng1 ng2
  printf 'sleep%s\n' "$R13_FORGE" >"$T/benv.sh"
  # R15: the exported function needs its `=` (env takes the text before the first `=` as the name); the R14 spelling lacked it, so the forged function never existed
  r13_live_start bashfunc 'RAW:sleep 1000' 'BASH_FUNC_sleep%%='"$R13_FORGE"
  r13_live_start bashenv 'RAW:sleep 1000' BASH_ENV="$T/benv.sh" ENV="$T/benv.sh"
  # the one vector that bash -p does not stop: the caller's PATH. A `sleep` planted ahead of /bin in the Guardian's own PATH answers 1000 with a forged feed.
  R14_PLANT=$'#!/bin/bash\nif [ "$1" = 1000 ]; then while :; do printf \'{"kill": false, "modes": {"opd9": "heal"}, "ts": %s}\\n\' "$(/bin/date +%s)"; /bin/sleep 5; done; else exec /bin/sleep "$@"; fi' \
    r13_live_start pathplant 'RAW:sleep 1000'
  # R15 (G14-3 iii): the grandchild case. The control command prints one fresh heal and then runs `/bin/sh -c "sleep 1000"`; sh imports an exported BASH_FUNC_sleep%%,
  # so a child environment that only lost `-i` (bash -p alone) lets the forged feed take over in the grandchild. Only a real `env -i` stops it.
  r13_live_start grand 'RAW:printf "{\"kill\": false, \"modes\": {\"opd9\": \"heal\"}, \"ts\": %s}\n" "$(/bin/date +%s)"; /bin/sh -c "sleep 1000"' 'BASH_FUNC_sleep%%='"$R13_FORGE"
  ng1="$(r13_wait_msg grand)"
  assert_eq "$([ -n "$ng1" ] && echo yes || echo no)" "yes" "grandchild run: its one legit message arrived (harness check)"
  # the forged feed (when it leaks) writes control.last within a second or two and the Guardian then acts at once
  i=0; while [ "$i" -lt 24 ]; do sleep 0.5; i=$((i + 1)); done
  ng2="$(r13_msg_epoch grand)"
  assert_eq "$ng2" "$ng1" "grandchild /bin/sh -c sleep: no second control message (the forged BASH_FUNC_sleep%% did not reach sh)"
  nf="$(r13_msg_epoch bashfunc)"; nb="$(r13_msg_epoch bashenv)"; np="$(r13_msg_epoch pathplant)"
  assert_eq "$nf" "" "BASH_FUNC_sleep%%: no control message arrived (the real sleep ran)"
  assert_eq "$nb" "" "BASH_ENV: no control message arrived (the real sleep ran)"
  assert_eq "$np" "" "planted sleep in the caller's PATH: no control message arrived (the pinned PATH ran the real sleep)"
  a="$(r13_mut_count bashfunc 0)"; b="$(r13_mut_count bashenv 0)"; c="$(r13_mut_count pathplant 0)"
  assert_eq "$c" "0" "planted sleep: 0 mutating calls"
  assert_eq "$a" "0" "BASH_FUNC_sleep%%: 0 mutating calls"
  assert_eq "$b" "0" "BASH_ENV: 0 mutating calls"
  assert_has "$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$T/bashfunc/home" PATH="$PROD_PATH" 'BASH_FUNC_sleep%%='"$R13_FORGE" /bin/bash -p "$KDIR/bin/guardian.sh" check 2>/dev/null)" "killswitch=engaged mode=shadow" "BASH_FUNC_sleep: engaged"
  assert_has "$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$T/bashenv/home" PATH="$PROD_PATH" BASH_ENV="$T/benv.sh" /bin/bash -p "$KDIR/bin/guardian.sh" check 2>/dev/null)" "killswitch=engaged mode=shadow" "BASH_ENV: engaged"
  kill -0 "$(cat "$T/bashfunc/main.pid")" 2>/dev/null && ok || fail "BASH_FUNC run: the Guardian itself is not running (harness check)"
  r13_live_stop bashfunc bashenv pathplant grand
}

# M1. The children of a conf command (publish, subscribe, control subscribe, the sudo path) get an allow-listed environment and bash -p.
test_r13_conf_command_children_get_an_allow_listed_environment() {
  local d="$T/envchk" h f k keys
  h="$d/home"; mkdir -p "$d" "$h/state"
  {
    printf 'GUARDIAN_ROOM="opd9"\n'
    printf "export GUARDIAN_PIPE_SSH='-i /k/id -o ConnectTimeout=5 pipe@host'\n"
    printf "GUARDIAN_PUBLISH_CMD='/usr/bin/env >%s/pub.env; echo \"\$-\" >%s/pub.flags; cat >/dev/null'\n" "$d" "$d"
    printf "GUARDIAN_SUBSCRIBE_CMD='/usr/bin/env >%s/sub.env; echo \"\$-\" >%s/sub.flags; sleep 1013'\n" "$d" "$d"
    printf "GUARDIAN_CONTROL_SUB_CMD='/usr/bin/env >%s/ctl.env; echo \"\$-\" >%s/ctl.flags; sleep 1013'\n" "$d" "$d"
    printf 'GUARDIAN_SUDO=""\n'
  } >"$h/guardian.conf"
  chmod 600 "$h/guardian.conf"
  printf 'x=1\n' >"$d/benv.sh"
  ( exec /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" \
      BASH_ENV="$d/benv.sh" ENV="$d/benv.sh" SHELLOPTS=xtrace BASHOPTS=extglob PS4='+EVIL ' IFS=x FOO=bar SSH_AUTH_SOCK=/tmp/agent.sock \
      'BASH_FUNC_evil%%=() { :; }' GUARDIAN_PIPE_SSH='-o ProxyCommand=evil' \
      /bin/bash -p "$KDIR/bin/guardian.sh" run >"$d/run.out" 2>&1 ) &
  echo $! >"$d/main.pid"
  local i=0
  while { [ ! -s "$d/pub.env" ] || [ ! -s "$d/sub.env" ] || [ ! -s "$d/ctl.env" ]; } && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
  for f in pub sub ctl; do
    [ -s "$d/$f.env" ] && ok || { fail "$f child did not run"; continue; }
    keys="$(sed 's/=.*//' "$d/$f.env" | grep -E '^[A-Za-z_][A-Za-z0-9_%]*$' | sort | tr '\n' ' ')"
    for k in BASH_ENV ENV SHELLOPTS BASHOPTS PS4 IFS FOO SSH_AUTH_SOCK BASH_FUNC_evil%% ; do
      case " $keys " in *" $k "*) fail "$f child has $k" ;; *) ok ;; esac
    done
    assert_has "$(cat "$d/$f.env")" '^PATH=/usr/bin:/bin:/usr/sbin:/sbin$' "$f child: the pinned PATH"
    assert_has "$(cat "$d/$f.env")" "^GUARDIAN_HOME=$h\$" "$f child: GUARDIAN_HOME"
    assert_has "$(cat "$d/$f.env")" '^GUARDIAN_PIPE_SSH=-i /k/id -o ConnectTimeout=5 pipe@host$' "$f child: GUARDIAN_PIPE_SSH is the conf value, not the environment's"
    assert_has "$(cat "$d/$f.flags")" 'p' "$f child: bash -p"
    assert_not "$(cat "$d/$f.flags")" 'x' "$f child: no xtrace"
    # nothing but the allow-list (bash adds PWD, SHLVL, _, OLDPWD)
    k="$(sed 's/=.*//' "$d/$f.env" | grep -vxE 'HOME|USER|LOGNAME|TMPDIR|PATH|GUARDIAN_HOME|GUARDIAN_PIPE_SSH|PWD|SHLVL|_|OLDPWD' | tr '\n' ' ')"
    assert_eq "$k" "" "$f child: no variable outside the allow-list"
  done
  r13_live_stop envchk
  kill "$(cat "$d/main.pid")" 2>/dev/null
}

# the sudo path gets the same clean environment (library function, run mode on)
test_r13_sudo_path_runs_under_the_clean_environment() {
  local out
  printf '#!/bin/bash\n/usr/bin/env\n' >"$T/bin/envsudo"; chmod +x "$T/bin/envsudo"
  out="$( G_RUNMODE=1; . "$KDIR/lib/common.sh"; GUARDIAN_SUDO="$T/bin/envsudo"; export BASH_ENV=/x FOO=bar 'BASH_FUNC_zz%%=() { :; }'; root_do tcc-row u 2>&1 )"
  assert_not "$out" "BASH_ENV" "sudo child: no BASH_ENV"
  assert_not "$out" "FOO=" "sudo child: no FOO"
  assert_has "$out" "^PATH=/usr/bin:/bin:/usr/sbin:/sbin$" "sudo child: pinned PATH"
}

# the one place conf commands start is g_conf_cmd: no bare bash -c anywhere in the code
test_r13_no_bare_bash_c_in_the_code() {
  assert_eq "$(grep -v '^[[:space:]]*#' "$KDIR/bin/guardian.sh" "$KDIR"/lib/*.sh | grep -cE '(^|[^_A-Za-z"])bash -c')" "0" "every conf command goes through g_conf_cmd"
}

# S2. run and check refuse to continue without bash -p: they re-exec once. Env functions that used to flip `check` no longer do.
test_r13_check_without_bash_p_reexecs_and_holds() {
  local old out f; old="$(( $(/bin/date +%s) - 600 ))"
  r12_write_conf ""; r12_msg 600
  for f in 'BASH_FUNC_shopt%%=() { return 0; }' 'BASH_FUNC_return%%=() { :; }' "BASH_FUNC_now_epoch%%=() { echo $old; }" 'BASH_FUNC_[%%=() { return 0; }' 'BASH_FUNC_trap%%=() { :; }'; do
    out="$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" "$f" /bin/bash "$KDIR/bin/guardian.sh" check 2>/dev/null)"
    assert_has "$out" "killswitch=engaged mode=shadow" "no -p, $f: still killed"
  done
  r12_msg 5
  assert_has "$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" 'BASH_FUNC_shopt%%=() { return 0; }' /bin/bash "$KDIR/bin/guardian.sh" check 2>/dev/null)" "killswitch=clear mode=heal" "positive control: the re-exec path gives the true answer for a fresh heal"
  # the marker argument is the loop guard: with it and no p, exit killed (rc 3), no state printed
  out="$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" /bin/bash "$KDIR/bin/guardian.sh" --reexec check 2>/dev/null)"; assert_rc $? 3 "marker without p: exit killed"
  assert_eq "$out" "" "and nothing is printed"
  out="$(/usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" /bin/bash "$KDIR/bin/guardian.sh" --reexec run 2>/dev/null)"; assert_rc $? 3 "run, marker without p: exit killed"
  # a hand-run `run` without -p re-execs under -p (no conf: it stops at "no room", rc 2, instead of looping)
  rm -f "$GUARDIAN_HOME/guardian.conf"
  "${R14_CAP[@]}" /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" /bin/bash "$KDIR/bin/guardian.sh" run >/dev/null 2>&1; assert_rc $? 2 "run without -p reached the room check through the re-exec"
}

# S1. A byte error rejects its own line only; the room survives and health keeps flowing. If no room can be read, `run` audits it and exits 2.
test_r13_byte_error_is_per_line_and_health_keeps_flowing() {
  local out
  r12_write_conf ""; printf '# note \xc3\xa9\n' >>"$GUARDIAN_HOME/guardian.conf"; r12_msg 1
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=conf" "a UTF-8 comment: killed (conf bad)"
  : >"$T/pub.log"
  prod PATH="$T/bin:$PROD_PATH" T="$T" CALLS="$CALLS" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" -- once >/dev/null
  assert_has "$(cat "$T/pub.log")" "kiosk/opd9/health" "health still published: the room survived"
  assert_has "$(cat "$T/pub.log")" '"mode":"shadow"' "and it says shadow"
  out="$(cat "$GUARDIAN_HOME/audit.log")"
  assert_has "$out" 'conf error line=[0-9]*: byte outside' "the bad line is audited by number"
  assert_not "$out" 'xc3' "never the content"
  # CRLF on one line, a NUL on another, a high byte on a third: each rejected alone, the others applied
  r12_write_conf ""; printf 'USB_MIC_PATTERN="C270"\r\nCANARY_VOLUME=0.2\nGUARDIAN_SUDO="a\0b"\n' >>"$GUARDIAN_HOME/guardian.conf"
  rm -f "$GUARDIAN_HOME/audit.log"; r12_msg 1
  assert_has "$(prod -- check)" "why=conf" "CR / NUL lines: killed"
  assert_eq "$(grep -c 'conf error line=' "$GUARDIAN_HOME/audit.log")" "2" "two bad lines, two audit lines"
  assert_eq "$(conf_parse_in_sub "$GUARDIAN_HOME/guardian.conf" GUARDIAN_ROOM CANARY_VOLUME)" "rc=1 GUARDIAN_ROOM=[opd9] CANARY_VOLUME=[0.2]" "the other lines are applied"
  # a file that is nothing but CRLF: no room at all. run audits one line per start and exits 2.
  sed 's/$/\r/' "$KDIR/guardian.conf.example" >"$GUARDIAN_HOME/guardian.conf"
  rm -f "$GUARDIAN_HOME/audit.log"
  prod -- run >/dev/null; assert_rc $? 2 "no room: rc 2"
  assert_eq "$(grep -c 'running KILLED: no room' "$GUARDIAN_HOME/audit.log")" "1" "one audit line per start"
  prod -- run >/dev/null
  assert_eq "$(grep -c 'running KILLED: no room' "$GUARDIAN_HOME/audit.log")" "2" "and one more on the next start"
  # the size cap stays a hard stop
  r12_write_conf ""; { printf '# '; head -c 17000 /dev/zero | tr '\0' 'x'; printf '\n'; } >>"$GUARDIAN_HOME/guardian.conf"
  rm -f "$GUARDIAN_HOME/audit.log"
  prod -- run >/dev/null; assert_rc $? 2 "over 16 KiB: nothing applied, no room, rc 2"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "over 16 KiB" "size cap audited"
}

# S5. GUARDIAN_TEST_ENTRY is honoured only next to tests/run.sh. An installed tree never has it.
test_r13_installed_tree_ignores_the_test_entry() {
  local out
  rm -rf "$GUARDIAN_HOME"
  GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" >/dev/null
  [ ! -e "$GUARDIAN_HOME/tests/run.sh" ] && ok || fail "install.sh copied tests/"
  r12_write_conf ""
  : >"$T/pub.log"; : >"$CALLS"
  /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$T/bin:$PROD_PATH" T="$T" CALLS="$CALLS" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" \
    GUARDIAN_TEST_ENTRY=1 GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW=5 GUARDIAN_FLAG_CMD='echo fleet=on; echo mode=heal' CANARY_AFPLAY="$T/bin/afplay" \
    /bin/bash "$GUARDIAN_HOME/bin/guardian.sh" once >/dev/null 2>&1
  out="$(grep -o '"ts":[0-9]*' "$T/pub.log" | head -n1 | cut -d: -f2)"
  [ -n "$out" ] && [ "$out" != "5" ] && ok || fail "installed once used the fake clock: [$out]"
  assert_not "$(cat "$GUARDIAN_HOME/state/flags.cache" 2>/dev/null)" "fleet=on" "FLAG_CMD ignored in the installed tree"
  assert_eq "$(grep -c '"ts":5[,}]' "$GUARDIAN_HOME/audit.log" 2>/dev/null)" "0" "no audit line at the fake epoch"
  assert_eq "$(grep -c '^afplay' "$CALLS")" "0" "CANARY_AFPLAY fake never called"
  : >"$T/pub.log"
  /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$GUARDIAN_HOME" PATH="$PROD_PATH" RR_ROOT="$RR_ROOT" GUARDIAN_TEST_ENTRY=1 GUARDIAN_TESTMODE=1 GUARDIAN_FAKE_NOW=5 \
    /bin/bash "$GUARDIAN_HOME/bin/guardian.sh" handle "kiosk/opd9/probe" "probe opd9 e3" >/dev/null 2>&1
  out="$(grep -o '"ts":[0-9]*' "$T/pub.log" | head -n1 | cut -d: -f2)"
  [ -n "$out" ] && [ "$out" != "5" ] && ok || fail "installed handle used the fake clock: [$out]"
}

# S6. Run mode: these are readonly after load. The canary volume audit text matches the check.
test_r13_more_names_are_readonly_in_run_mode() {
  local nm out
  for nm in G_AFPLAY CANARY_MIN_GAP_S CONTROL_RE CONTROL_LAST; do
    out="$(G_RUNMODE=1 /bin/bash -c '. "$1/lib/common.sh"; . "$1/lib/killswitch.sh"; . "$1/lib/canary.sh"; if ( eval "$2=x" ) 2>/dev/null; then echo assignable; else echo readonly; fi' _ "$KDIR" "$nm" 2>&1)"
    assert_eq "$out" "readonly" "$nm is readonly in run mode"
  done
  out="$( . "$KDIR/lib/common.sh"; . "$KDIR/lib/killswitch.sh"; . "$KDIR/lib/canary.sh"; G_AFPLAY=/x; CONTROL_LAST=/y; echo "$G_AFPLAY $CONTROL_LAST" )"
  assert_eq "$out" "/x /y" "library tests may still re-point them"
  assert_eq "$(grep -c '(0,1\]' "$KDIR/lib/canary.sh")" "0" "no (0,1] left in canary.sh"
  assert_has "$(cat "$KDIR/lib/canary.sh")" 'CANARY_VOLUME is not in (0,0.5\]' "the audit text says (0,0.5]"
}

# The orphan rule through the real run: a SIGKILL of the real main leaves no conf-command child behind.
test_r13_sigkill_of_the_real_main_leaves_no_transport_child() {
  local d="$T/orph" h p i alive
  h="$d/home"; mkdir -p "$d" "$h/state"
  {
    printf 'GUARDIAN_ROOM="opd9"\n'
    printf "GUARDIAN_PUBLISH_CMD='cat >/dev/null'\n"
    printf "GUARDIAN_SUBSCRIBE_CMD='echo \$\$ >>%s/sub.pid; sleep 1013 & echo \$! >>%s/sub.pid; wait'\n" "$d" "$d"
    printf "GUARDIAN_CONTROL_SUB_CMD='echo \$\$ >>%s/ctl.pid; sleep 1014 & echo \$! >>%s/ctl.pid; wait'\n" "$d" "$d"
    printf 'GUARDIAN_SUDO=""\n'
  } >"$h/guardian.conf"
  chmod 600 "$h/guardian.conf"
  ( exec /usr/bin/env -i HOME="$HOME" GUARDIAN_HOME="$h" PATH="$PROD_PATH" RR_ROOT="$RR_ROOT" RR_PLIST="$RR_PLIST" RR_APP="$RR_APP" \
      /bin/bash -p "$KDIR/bin/guardian.sh" run >"$d/run.out" 2>&1 ) &
  echo $! >"$d/main.pid"
  i=0; while { [ "$(wc -l <"$d/sub.pid" 2>/dev/null | tr -d ' ')" != 2 ] || [ "$(wc -l <"$d/ctl.pid" 2>/dev/null | tr -d ' ')" != 2 ]; } && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
  alive=0; for p in $(cat "$d/sub.pid" "$d/ctl.pid" 2>/dev/null); do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done
  assert_eq "$alive" "4" "both transport shells and both sleeps are up"
  # main.pid is the real guardian.sh (the subshell exec'd into it)
  kill -9 "$(cat "$d/main.pid")" 2>/dev/null
  i=0
  while [ "$i" -lt 30 ]; do
    alive=0; for p in $(cat "$d/sub.pid" "$d/ctl.pid" 2>/dev/null); do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done
    [ "$alive" -eq 0 ] && break
    sleep 0.5; i=$((i + 1))
  done
  assert_eq "$alive" "0" "no transport child left within 15 s of SIGKILL of the real main"
}

# C3 rerun 11 MUST 2: the conf must be a regular file (not a symlink), owned by root or the agent's uid, and not group- or world-writable.
# Hard stop: no key is read (so no room), killed, one audit line "conf rejected: <why>".
test_r13_conf_file_type_owner_and_mode_are_checked() {
  local out good="$T/good.conf"
  r12_write_conf ""; cp "$GUARDIAN_HOME/guardian.conf" "$good"; chmod 600 "$good"; r12_msg 1
  assert_has "$(prod -- check)" "killswitch=clear mode=heal" "positive control: a 0600 regular file owned by the agent passes"
  chmod 640 "$GUARDIAN_HOME/guardian.conf"; assert_has "$(prod -- check)" "killswitch=clear mode=heal" "0640 passes (not writable)"
  chmod 644 "$GUARDIAN_HOME/guardian.conf"; assert_has "$(prod -- check)" "killswitch=clear mode=heal" "0644 passes"
  chmod 666 "$GUARDIAN_HOME/guardian.conf"; rm -f "$GUARDIAN_HOME/audit.log"
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=conf" "world-writable: killed"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "conf rejected: mode" "audit: mode"
  chmod 660 "$GUARDIAN_HOME/guardian.conf"; rm -f "$GUARDIAN_HOME/audit.log"
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=conf" "group-writable: killed"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "conf rejected: mode" "audit: mode (group)"
  chmod 602 "$GUARDIAN_HOME/guardian.conf"
  assert_has "$(prod -- check)" "why=conf" "other-write only: killed"
  rm -f "$GUARDIAN_HOME/guardian.conf"; ln -s "$good" "$GUARDIAN_HOME/guardian.conf"; rm -f "$GUARDIAN_HOME/audit.log"
  assert_has "$(prod -- check)" "killswitch=engaged mode=shadow why=conf" "symlink to a good conf: killed"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "conf rejected: symlink" "audit: symlink"
  rm -f "$GUARDIAN_HOME/guardian.conf"; ln -s "$T/nowhere" "$GUARDIAN_HOME/guardian.conf"
  assert_has "$(prod -- check)" "why=conf" "dangling symlink: killed"
  rm -f "$GUARDIAN_HOME/guardian.conf"; mkdir "$GUARDIAN_HOME/guardian.conf"; rm -f "$GUARDIAN_HOME/audit.log"
  assert_has "$(prod -- check)" "why=conf" "directory: killed"
  assert_has "$(cat "$GUARDIAN_HOME/audit.log")" "conf rejected: not regular" "audit: not regular"
  rmdir "$GUARDIAN_HOME/guardian.conf"
  # nothing was read from a rejected file: a good body behind a bad mode gives no room, so run stops at rc 2
  cp "$good" "$GUARDIAN_HOME/guardian.conf"; chmod 666 "$GUARDIAN_HOME/guardian.conf"
  prod -- run >/dev/null; assert_rc $? 2 "rejected conf: no key read, no room, rc 2"
  # another uid: root-owned is accepted, anyone else is not. A harness cannot chown to another uid without root, so this case is checked on the function.
  if [ "$(id -u)" = 0 ]; then
    cp "$good" "$GUARDIAN_HOME/guardian.conf"; chmod 600 "$GUARDIAN_HOME/guardian.conf"; chown 12345 "$GUARDIAN_HOME/guardian.conf"
    assert_has "$(prod -- check)" "why=conf" "foreign owner: killed"
  else
    printf '#!/bin/bash\necho "4242 600 Regular File"\n' >"$T/bin/fakestat"; chmod +x "$T/bin/fakestat"
    cp "$good" "$T/own.conf"
    out="$( readonly G_STAT="$T/bin/fakestat"; . "$KDIR/lib/common.sh"; . "$KDIR/lib/conf.sh"; audit() { echo "$*"; }; conf_perms_ok "$T/own.conf"; echo "rc=$?" )"
    assert_has "$out" "conf rejected: owner" "a file owned by another uid (stat shim says uid 4242; a real chown needs root, so the real-file case runs only as root): rejected"
    assert_has "$out" "rc=1" "and rc 1"
  fi
  # a root-owned file passes the owner check (/etc/hosts is root-owned, 0644 here)
  out="$( . "$KDIR/lib/common.sh"; . "$KDIR/lib/conf.sh"; audit() { echo "$*"; }; conf_perms_ok /etc/hosts; echo "rc=$?" )"
  assert_has "$out" "rc=0" "root-owned, not writable: accepted"
}
test_r13_install_writes_a_conf_that_passes_the_check() {
  rm -rf "$GUARDIAN_HOME"
  chmod 644 "$T/good.conf" 2>/dev/null
  printf 'GUARDIAN_ROOM="opd9"\nGUARDIAN_CONTROL_SUB_CMD='"'"'true'"'"'\n' >"$T/in.conf"; chmod 664 "$T/in.conf"
  GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --config "$T/in.conf" --sudo "$T/bin/fakesudo" >/dev/null 2>&1
  assert_rc $? 0 "install accepts a --config source of any mode (the lint is for content)"
  assert_eq "$(/usr/bin/stat -f '%Lp %u %HT' "$GUARDIAN_HOME/guardian.conf")" "600 $(id -u) Regular File" "installed conf: regular, 0600, the agent's uid"
  assert_has "$(conf_parse_in_sub "$GUARDIAN_HOME/guardian.conf" GUARDIAN_ROOM)" "rc=0 GUARDIAN_ROOM=\[opd9\]" "and it passes conf_load with the check on"
  rm -rf "$GUARDIAN_HOME"
  GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" >/dev/null 2>&1
  assert_eq "$(/usr/bin/stat -f '%Lp %u %HT' "$GUARDIAN_HOME/guardian.conf")" "600 $(id -u) Regular File" "installed stub conf: regular, 0600, the agent's uid"
}
