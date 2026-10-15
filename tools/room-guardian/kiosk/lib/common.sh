#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: shared helpers. bash 3.2 compatible (macOS). No python3, no osascript.
# Sourced, never executed. Every external effect goes through a PATH command or a GUARDIAN_* command
# variable, so tests can substitute fakes.

GUARDIAN_VERSION="c1-0.2.1-r11"   # bump per release: the audit "guardian start version=" line identifies the tree
# External tools on the control and flag paths (the clock, cat, sed, head, mv, mkdir included) are pinned to absolute paths (R10, R11): a PATH change or a planted binary cannot turn a kill into a clear or freeze the 90 s stale rule.
G_TR=/usr/bin/tr
G_WC=/usr/bin/wc
G_SED=/usr/bin/sed
G_TAIL=/usr/bin/tail
G_HEAD=/usr/bin/head
G_CAT=/bin/cat
G_PS=/bin/ps
G_DATE=/bin/date
G_MV=/bin/mv
G_MKDIR=/bin/mkdir

: "${GUARDIAN_HOME:=$HOME/Library/Application Support/EvenScribe/Guardian}"
: "${RR_ROOT:=$HOME/Library/Application Support/EvenScribe/RoomRecorder}"
: "${RR_LABEL:=com.evenscribe.room-recorder}"
: "${RR_PLIST:=$HOME/Library/LaunchAgents/$RR_LABEL.plist}"
: "${RR_APP:=/Applications/EvenScribe Room Recorder.app}"
: "${GUARDIAN_ROOM:=}"
: "${GUARDIAN_PUBLISH_CMD:=}"
: "${GUARDIAN_SUBSCRIBE_CMD:=}"
: "${GUARDIAN_FLAG_CMD:=}"
: "${GUARDIAN_CONTROL_SUB_CMD:=}"
: "${GUARDIAN_CONTROL_TOPIC:=guardian/control}"
: "${GUARDIAN_SUDO:=}"
: "${GUARDIAN_ROOT_HELPER:=/usr/local/libexec/eta-guardian-root}"
: "${USB_MIC_PATTERN:=C270}"
: "${PRESENCE_FILE:=}"
: "${CLINIC_START:=0800}"
: "${CLINIC_END:=2135}"
: "${NIGHT_START:=2135}"
: "${NIGHT_END:=0600}"
: "${HUNG_AFTER_S:=600}"
: "${PRESENCE_STALE_S:=300}"
: "${FLAG_MAX_AGE_S:=30}"
: "${CONFIRM_TIMEOUT_S:=30}"
: "${HEAL_MAX_PER_HOUR:=3}"
: "${IDLE_MIN_S:=600}"
: "${SPEECH_GATE_DBFS:=-50}"   # INFERRED: tape RMS at or above this is speech
: "${SPEECH_QUIET_S:=600}"
: "${FLAG_FETCH_S:=10}"
: "${CONTROL_STALE_S:=90}"   # no control message for longer than this = kill (C4)
: "${PUBLISH_CAP_S:=4}"

STATE_DIR="$GUARDIAN_HOME/state"
AUDIT_LOG="$GUARDIAN_HOME/audit.log"
FLAG_DIR="$GUARDIAN_HOME/flags"

gsleep() { sleep "$1"; }

now_epoch() {
  # GUARDIAN_FAKE_NOW is honoured only in test mode: a frozen clock set in guardian.conf or the environment would disable the 90 s kill.
  if [ "${GUARDIAN_TESTMODE:-}" = 1 ] && [ -n "${GUARDIAN_FAKE_NOW:-}" ]; then echo "$GUARDIAN_FAKE_NOW"; else "$G_DATE" +%s; fi
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
  RC_STDIN="$tmp.in" run_capped "$PUBLISH_CAP_S" "$tmp" bash -c "$GUARDIAN_PUBLISH_CMD" _ "$topic"
  local rc=$?
  rm -f "$tmp" "$tmp.in"
  [ "$rc" -eq 0 ] || audit "publish_failed topic=$topic rc=$rc"
  return "$rc"
}

# sudo only through the configured kiosk-sudo path, only the root helper (G5).
root_do() {
  if [ -z "$GUARDIAN_SUDO" ]; then audit "root_do refused: no sudo path"; return 97; fi
  $GUARDIAN_SUDO "$GUARDIAN_ROOT_HELPER" "$@"
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
