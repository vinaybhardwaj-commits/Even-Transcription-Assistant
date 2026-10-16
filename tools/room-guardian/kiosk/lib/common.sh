#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: shared helpers. bash 3.2 compatible (macOS). No python3, no osascript.
# Sourced, never executed. Every external effect goes through a PATH command or a GUARDIAN_* command
# variable, so tests can substitute fakes.

GUARDIAN_VERSION="c1-0.4.5-r16c"   # bump per release: the audit "guardian start version=" line identifies the tree

# R12. Run mode (guardian.sh run|check, G_RUNMODE=1) reads no test seam and no environment tunable: every name below is assigned its default
# unconditionally and only guardian.conf (parsed as data by conf.sh, never sourced) can change the allow-listed keys. Library tests source this
# file without G_RUNMODE and keep the old "environment overrides the default" behaviour.
g_def() { # NAME DEFAULT
  if [ "${G_RUNMODE:-}" = 1 ]; then printf -v "$1" '%s' "$2"; else [ -n "${!1:-}" ] || printf -v "$1" '%s' "$2"; fi
}
# g_const NAME VALUE: a safety number or a pinned tool. Assigned unconditionally, then readonly. If the name was already readonly with another
# value (cannot happen from the environment), G_BAD_CONST is set and the kill switch stays engaged.
g_const() {
  { printf -v "$1" '%s' "$2"; } 2>/dev/null
  [ "${!1}" = "$2" ] || G_BAD_CONST=1
  readonly "$1" 2>/dev/null
}
G_BAD_CONST="${G_BAD_CONST:-}"; [ "${G_RUNMODE:-}" = 1 ] && G_BAD_CONST=""

# Safety numbers: constants in code. Not settable from guardian.conf (not an allow-listed key), the environment or a test.
g_const CONTROL_STALE_S 90      # no control message for longer than this = kill (C4); also the age limit on the message's own ts
g_const CONTROL_SKEW_S 30       # a ts further ahead than this = kill
g_const CONTROL_MAX_BYTES 4096  # payload cap
g_const CONTROL_LINE_MAX 4200   # read cap per line in control_pump
g_const FLAG_FETCH_S 10
# External tools on the control and flag paths are pinned to absolute paths (R10, R11, R12): a PATH change or a planted binary cannot turn a kill into a clear.
# bash itself and the transport commands run through PATH; the conf is data, so only whoever can write the agent directory controls those.
g_const G_TR /usr/bin/tr
g_const G_WC /usr/bin/wc
g_const G_SED /usr/bin/sed
g_const G_TAIL /usr/bin/tail
g_const G_HEAD /usr/bin/head
g_const G_CAT /bin/cat
g_const G_PS /bin/ps
g_const G_DATE /bin/date
g_const G_MV /bin/mv
g_const G_MKDIR /bin/mkdir
g_const G_GREP /usr/bin/grep
g_const G_ENV /usr/bin/env
g_const G_BASH /bin/bash
g_const G_ID /usr/bin/id
g_const G_STAT /usr/bin/stat
g_const G_LS /bin/ls
g_const G_MKTEMP /usr/bin/mktemp
# 2.4 d': the unified-log reader is pinned too (a bare `log` is a zsh builtin). Library tests may point it at a fake through GUARDIAN_LOG_BIN; run mode never reads that name.
if [ "${G_RUNMODE:-}" = 1 ]; then g_const G_LOG /usr/bin/log; else g_const G_LOG "${GUARDIAN_LOG_BIN:-/usr/bin/log}"; fi
# The PATH every conf command (transport, sudo path) is started with in run mode (R13): a constant, never the caller's PATH.
# R14 A4: system directories only. /opt/homebrew/bin is writable by the agent's uid (and group admin) on a kiosk, so a planted file there would replace a
# transport binary. A conf command that needs a tool outside these four directories names it by absolute path.
g_const G_CHILD_PATH /usr/bin:/bin:/usr/sbin:/sbin

: "${GUARDIAN_HOME:=$HOME/Library/Application Support/EvenScribe/Guardian}"
: "${RR_ROOT:=$HOME/Library/Application Support/EvenScribe/RoomRecorder}"
: "${RR_LABEL:=com.evenscribe.room-recorder}"
: "${RR_PLIST:=$HOME/Library/LaunchAgents/$RR_LABEL.plist}"
: "${RR_APP:=/Applications/EvenScribe Room Recorder.app}"
# guardian.conf keys (allow-listed in conf.sh)
g_def GUARDIAN_ROOM ""
g_def GUARDIAN_PUBLISH_CMD ""
g_def GUARDIAN_SUBSCRIBE_CMD ""
g_def GUARDIAN_CONTROL_SUB_CMD ""
g_def GUARDIAN_SUDO ""
g_def GUARDIAN_ROOT_HELPER /usr/local/libexec/eta-guardian-root
g_def USB_MIC_PATTERN C270
g_def PRESENCE_FILE ""
g_def CANARY_VOLUME 0.3   # afplay -v; the system volume is never changed
# not conf keys: fixed defaults in run mode (the heal cap and the canary window / idle limit are constants)
g_def GUARDIAN_FLAG_CMD ""   # old flag path; run mode never uses it (killswitch.sh)
g_def GUARDIAN_CONTROL_TOPIC guardian/control
g_def CLINIC_START 0800
g_def CLINIC_END 2135
g_def NIGHT_START 2135
g_def NIGHT_END 0600
g_def HUNG_AFTER_S 600
g_def PRESENCE_STALE_S 300
g_def FLAG_MAX_AGE_S 30
g_def CONFIRM_TIMEOUT_S 30
g_const HEAL_MAX_PER_HOUR 3
# 2.4 d' (USB-C power-off -> reboot): safety numbers, constants in code, not conf keys.
# A: d' stays SHADOW (would_do only) in this build whatever the mode says. Flipping it to 1 is its own one-line commit after the Fable gate. A code constant, not a conf key;
# run mode assigns 0 unconditionally. Library tests may set GUARDIAN_TEST_DPRIME_HEAL (the same pattern as G_LOG): guardian.sh run|check never read it.
if [ "${G_RUNMODE:-}" = 1 ]; then g_const USB_DPRIME_HEAL 0; else g_const USB_DPRIME_HEAL "${GUARDIAN_TEST_DPRIME_HEAL:-0}"; fi
g_const USB_BUDGET_S 86400          # B: the reboot budget is spent for this long after the state epoch as well as for the IST day
g_const USB_ABSENT_MIN_TICKS 2      # the capture device absent for this many consecutive health ticks
g_const USB_ABSENT_MIN_SPAN_S 20    # AND the first absent tick at least this many seconds ago (tick spacing is only >= 5 s)
g_const USB_HID_IDLE_MIN_S 600      # HID idle needed before a reboot
g_const USB_CC_MAX_AGE_S 900        # the cable-detect line must be inside the last 15 min
g_const USB_LOG_CAP_S 4             # cap on the log probe
g_const USB_VERIFY_S 600            # the kiosk-side verify window after the reboot
g_const USB_LOCK_S 86400            # lock after a failed verify
# Fixed predicate (INFERRED from the OPD 5 log lines): kernel, subsystem com.apple.usb:all, message contains the cable-detect text.
g_const USB_LOG_PREDICATE 'process == "kernel" AND processID == 0 AND subsystem == "com.apple.usb:all" AND eventMessage CONTAINS "AppleUSBHostPort::cableChangeOccurred: powering off"'
g_def IDLE_MIN_S 600
g_def SPEECH_GATE_DBFS -50   # INFERRED: tape RMS at or above this is speech
g_def SPEECH_QUIET_S 600
g_def PUBLISH_CAP_S 4
g_def CANARY_ENABLED 1
g_const CANARY_START 2135
g_const CANARY_END 0700
g_const CANARY_IDLE_MIN_S 600
g_def CANARY_PASS_DB 20   # tone window must rise this far above the 5 s before it
g_def CANARY_SAMPLE_S 7   # seconds after the start at which the tape is read (checkpoint lag)
g_def GUARDIAN_SETTLE_S 1

STATE_DIR="$GUARDIAN_HOME/state"
AUDIT_LOG="$GUARDIAN_HOME/audit.log"
FLAG_DIR="$GUARDIAN_HOME/flags"

# g_clean_exec <argv...> (R13 M1): run a child that executes a conf command. In run mode the child gets an ALLOW-LISTED environment:
# `env -i` plus HOME, USER, LOGNAME, TMPDIR (if set), the pinned PATH, GUARDIAN_HOME and GUARDIAN_PIPE_SSH (if the conf set it).
# So no BASH_ENV, ENV, BASH_FUNC_*, SHELLOPTS, BASHOPTS, PS4 or IFS from outside reaches the child. SSH_AUTH_SOCK is not passed: the pipe uses the key
# file in the agent directory (GUARDIAN_PIPE_SSH names it), so no current code path needs an agent socket.
# Library tests (G_RUNMODE unset) keep the caller's environment, because the fakes and sandbox paths travel in it.
g_clean_envv() { # fills the array G_CLEAN_ENV with the allow-listed environment (run mode)
  G_CLEAN_ENV=("HOME=$HOME" "USER=${USER:-$("$G_ID" -un)}" "LOGNAME=${LOGNAME:-${USER:-$("$G_ID" -un)}}" "PATH=$G_CHILD_PATH" "GUARDIAN_HOME=$GUARDIAN_HOME")
  [ -z "${TMPDIR:-}" ] || G_CLEAN_ENV+=("TMPDIR=$TMPDIR")
  [ -z "${GUARDIAN_PIPE_SSH+x}" ] || G_CLEAN_ENV+=("GUARDIAN_PIPE_SSH=$GUARDIAN_PIPE_SSH")
}
g_clean_exec() {
  if [ "${G_RUNMODE:-}" != 1 ]; then "$@"; return; fi
  local -a G_CLEAN_ENV
  g_clean_envv
  "$G_ENV" -i "${G_CLEAN_ENV[@]}" "$@"
}
# g_ppid (R14 A3): print the pid of the shell that called this (run inside $(...)). The one `sh -c` start that is not a conf command: in run mode it gets the same
# allow-listed environment, so an exported BASH_FUNC_echo (sh imports functions) cannot forge the pid. The exec keeps sh's parent = the caller's shell.
g_ppid() {
  if [ "${G_RUNMODE:-}" = 1 ]; then
    local -a G_CLEAN_ENV
    g_clean_envv
    # shellcheck disable=SC2016
    exec "$G_ENV" -i "${G_CLEAN_ENV[@]}" /bin/sh -c 'echo $PPID'
  fi
  exec sh -c 'echo $PPID'   # library tests: the caller's PATH, so a fake sh can stand in
}
# g_conf_cmd <command string> <args...>: the one way a conf command is run. bash -p (no startup file, no imported function) under the clean env.
g_conf_cmd() {
  local c="$1"; shift
  g_clean_exec "$G_BASH" -p -c "$c" _ "$@"
}

gsleep() { sleep "$1"; }

now_epoch() {
  # GUARDIAN_FAKE_NOW is a library-test seam: never in run mode (G_RUNMODE=1, readonly), where a frozen clock would disable the 90 s kill.
  if [ "${G_RUNMODE:-}" != 1 ] && [ "${GUARDIAN_TESTMODE:-}" = 1 ] && [ -n "${GUARDIAN_FAKE_NOW:-}" ]; then echo "$GUARDIAN_FAKE_NOW"; else "$G_DATE" +%s; fi
}

# HHMM in Asia/Kolkata for an epoch (default now).
ist_hhmm() {
  local e="${1:-$(now_epoch)}"
  TZ=Asia/Kolkata "$G_DATE" -r "$e" +%H%M 2>/dev/null || TZ=Asia/Kolkata "$G_DATE" -d "@$e" +%H%M
}

# 0 when HHMM is inside [start,end) (end may wrap past midnight).
hhmm_in_window() {
  local t="$((10#$1))" s="$((10#$2))" e="$((10#$3))"
  if [ "$s" -le "$e" ]; then
    [ "$t" -ge "$s" ] && [ "$t" -lt "$e" ]
  else
    [ "$t" -ge "$s" ] || [ "$t" -lt "$e" ]
  fi
}

in_clinic_hours() { hhmm_in_window "$(ist_hhmm)" "$CLINIC_START" "$CLINIC_END"; }
in_night_window() { hhmm_in_window "$(ist_hhmm)" "$NIGHT_START" "$NIGHT_END"; }

# YYYYMMDD in Asia/Kolkata for an epoch (default now).
ist_date() {
  local e="${1:-$(now_epoch)}"
  TZ=Asia/Kolkata "$G_DATE" -r "$e" +%Y%m%d 2>/dev/null || TZ=Asia/Kolkata "$G_DATE" -d "@$e" +%Y%m%d
}

# ---- JSON out (hand built; escape \ " and control characters) ----
jesc() { printf '%s' "$1" | "$G_SED" -e 's/\\/\\\\/g' -e 's/"/\\"/g' | "$G_TR" '\n\t\r' '   '; }
jstr() { if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$(jesc "$1")"; fi; }
# Same output as jstr, no subshell and no external process: jstr_v <value> sets JSTR_V. For hot paths under load.
jstr_v() {
  local s="$1" nl=$'\n' tb=$'\t' cr=$'\r'
  if [ -z "$s" ]; then JSTR_V=null; return; fi
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$nl/ }"; s="${s//$tb/ }"; s="${s//$cr/ }"
  JSTR_V="\"$s\""
}
jnum() { case "$1" in ''|*[!0-9.-]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }
jbool() { case "$1" in true|false) printf '%s' "$1" ;; *) printf 'null' ;; esac; }

# ---- JSON in: first top-level-looking "key": value. Empty for missing or null. ----
json_get() {
  local f="$1" k="$2" v
  [ -r "$f" ] || return 0
  v="$("$G_TR" -d '\n' <"$f" | "$G_SED" -nE 's/.*"'"$k"'"[[:space:]]*:[[:space:]]*("([^"]*)"|([^,}[:space:]]*)).*/\2\3/p' | "$G_HEAD" -n1)"
  [ "$v" = "null" ] && v=""
  printf '%s' "$v"
}

# Epoch from epoch seconds, epoch ms, or ISO-8601 (fraction and zone ignored, read as UTC). Empty on failure.
ts_to_epoch() {
  local v="$1" b
  case "$v" in
    '') return 0 ;;
    *[!0-9]*)
      b="$(printf '%s' "$v" | sed -e 's/\.[0-9]*//' -e 's/Z$//' -e 's/[+-][0-9][0-9]:\{0,1\}[0-9][0-9]$//')"
      date -j -u -f '%Y-%m-%dT%H:%M:%S' "$b" +%s 2>/dev/null || date -u -d "$b" +%s 2>/dev/null
      ;;
    *) if [ "${#v}" -ge 12 ]; then echo "$((v / 1000))"; else echo "$v"; fi ;;
  esac
}

# [[dd-]hh:]mm:ss -> seconds
etime_to_s() {
  printf '%s' "$1" | tr -d ' ' | awk -F'[-:]' '
    { n=NF; if (n==2) print $1*60+$2; else if (n==3) print $1*3600+$2*60+$3; else if (n==4) print $1*86400+$2*3600+$3*60+$4 }'
}

# ---- local audit (append only; G4 no deletes) ----
audit() {
  "$G_MKDIR" -p "$GUARDIAN_HOME" 2>/dev/null
  printf '{"ts":%s,"room_id":%s,"msg":%s}\n' "$(now_epoch)" "$(jstr "$GUARDIAN_ROOM")" "$(jstr "$*")" >>"$AUDIT_LOG" 2>/dev/null
}

# Run "$@" capped at N seconds; stdout to file. rc 124 on timeout. Kills the process group children too.
run_capped() {
  local cap="$1" out="$2"; shift 2
  local pid w rc flag
  flag="$out.timeout"
  rm -f "$flag" 2>/dev/null
  ("$@" <"${RC_STDIN:-/dev/null}" >"$out" 2>/dev/null) &
  pid=$!
  ( sleep "$cap"; : >"$flag"; pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null ) &
  w=$!
  wait "$pid" 2>/dev/null; rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  if [ -e "$flag" ]; then rm -f "$flag"; return 124; fi
  return "$rc"
}

# ---- transport (injectable) ----
# publish <topic> <line>: the command gets the topic as $1 and the line on stdin.
publish() {
  local topic="$1" line="$2" tmp
  [ -n "$GUARDIAN_PUBLISH_CMD" ] || return 0
  mkdir -p "$STATE_DIR" 2>/dev/null
  tmp="$STATE_DIR/pub.$$.out"
  printf '%s\n' "$line" >"$tmp.in"
  RC_STDIN="$tmp.in" run_capped "$PUBLISH_CAP_S" "$tmp" g_conf_cmd "$GUARDIAN_PUBLISH_CMD" "$topic"
  local rc=$?
  rm -f "$tmp" "$tmp.in"
  [ "$rc" -eq 0 ] || audit "publish_failed topic=$topic rc=$rc"
  return "$rc"
}

# sudo only through the configured kiosk-sudo path, only the root helper (G5).
root_do() {
  if [ -z "$GUARDIAN_SUDO" ]; then audit "root_do refused: no sudo path"; return 97; fi
  # shellcheck disable=SC2086
  g_clean_exec $GUARDIAN_SUDO "$GUARDIAN_ROOT_HELPER" "$@"
}

# stamp files: once_per <key> <secs> -> 0 when allowed (and records), 1 when still inside the window
once_per() {
  local key="$1" secs="$2" f last now
  mkdir -p "$STATE_DIR/once" 2>/dev/null
  f="$STATE_DIR/once/$(printf '%s' "$key" | tr -c 'A-Za-z0-9_.-' '_')"
  now="$(now_epoch)"
  last="$(cat "$f" 2>/dev/null)"
  if [ -n "$last" ] && [ "$((now - last))" -lt "$secs" ]; then return 1; fi
  printf '%s\n' "$now" >"$f"
  return 0
}

# Monotonic-enough milliseconds for deadlines. date +%N where the OS has it (macOS 26), else whole seconds.
mono_ms() {
  local n; n="$(date +%s%N 2>/dev/null)"
  case "$n" in ''|*[!0-9]*) echo "$(( $(date +%s) * 1000 ))" ;; *) echo "$((n / 1000000))" ;; esac
}
