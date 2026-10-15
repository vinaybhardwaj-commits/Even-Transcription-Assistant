#!/bin/bash
# Kiosk Guardian main loop (launchd user agent, runs as the console user).
#   guardian.sh run      loop forever: health line every 10 s, heal cycle, subscriber child
#   guardian.sh once     one tick (collect, publish health, heal cycle) and exit
#   guardian.sh handle <topic> <payload>   answer one message (used by tests)
#   guardian.sh check    print the kill switch state and mode once, through the run-mode preamble (diagnostics and tests)
# Config: $GUARDIAN_HOME/guardian.conf, parsed as DATA by lib/conf.sh (R12). It is never sourced. Not in git.
#
# R12 run-mode preamble. `run` and `check` (and `once`/`handle` unless GUARDIAN_TEST_ENTRY=1, which only the test harness sets) ignore the
# environment for every test seam and every tunable: GUARDIAN_TESTMODE, GUARDIAN_FAKE_NOW, GUARDIAN_PS, GUARDIAN_FLAG_CMD, GUARDIAN_CONF and the rest.
# The safety numbers are readonly constants in lib/common.sh, set before anything else runs. The only way to change behaviour is the conf's allow-listed keys.

# R13 S2. run and check refuse to continue without `bash -p` (no BASH_FUNC_* import, no BASH_ENV, no SHELLOPTS). Only keywords are used before the
# re-exec. The one re-exec carries a marker ARGUMENT (an argument cannot come from the environment); if p is still missing after it, exit killed.
G_REEXEC=0
if [[ ${1:-} == --reexec ]]; then G_REEXEC=1; shift; fi
if [[ $- != *p* ]] && [[ ${1:-run} == run || ${1:-} == check ]]; then
  if [[ $G_REEXEC == 1 ]]; then echo "guardian: bash -p could not be set: KILLED" >&2; exit 3; fi
  exec /bin/bash -p "$0" --reexec "$@"
fi

# No alias, no DEBUG/ERR/RETURN trap, no functrace may survive from the caller's environment.
shopt -u expand_aliases 2>/dev/null
trap - DEBUG ERR RETURN 2>/dev/null
set +T +E 2>/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
G_MODE_ARG="${1:-run}"
# R13 S5. The test entry is honoured only for once|handle, with GUARDIAN_TEST_ENTRY=1, and only when the test harness file sits next to this
# script tree. install.sh never copies tests/, so an installed tree has no such file and ignores the variable.
if [ "${GUARDIAN_TEST_ENTRY:-}" = 1 ] && { [ "$G_MODE_ARG" = once ] || [ "$G_MODE_ARG" = handle ]; } && [ -f "$HERE/tests/run.sh" ]; then
  unset G_RUNMODE G_CONF_BAD G_BAD_CONST
  CONF="${GUARDIAN_CONF:-${GUARDIAN_HOME:-$HOME/Library/Application Support/EvenScribe/Guardian}/guardian.conf}"
else
  unset GUARDIAN_TESTMODE GUARDIAN_FAKE_NOW GUARDIAN_PS GUARDIAN_FLAG_CMD GUARDIAN_CONF GUARDIAN_TEST_ENTRY CANARY_AFPLAY \
    GUARDIAN_ROOT_TESTMODE GUARDIAN_ROOT_TEST_DB FAKE_SP_SLEEP G_CONF_BAD G_BAD_CONST GUARDIAN_PIPE_SSH
  G_RUNMODE=1; readonly G_RUNMODE
  CONF="${GUARDIAN_HOME:-$HOME/Library/Application Support/EvenScribe/Guardian}/guardian.conf"
fi
# shellcheck source=../lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=../lib/conf.sh
. "$HERE/lib/conf.sh"
# The conf, as data. Any error leaves the agent KILLED; the valid keys are still applied so health keeps flowing.
G_CONF_BAD=0
if ! conf_load "$CONF"; then G_CONF_BAD=1; fi
[ "${G_RUNMODE:-}" = 1 ] && readonly G_CONF_BAD
# shellcheck source=../lib/collect.sh
. "$HERE/lib/collect.sh"
# shellcheck source=../lib/killswitch.sh
. "$HERE/lib/killswitch.sh"
# shellcheck source=../lib/faulttree.sh
. "$HERE/lib/faulttree.sh"
# shellcheck source=../lib/heal.sh
. "$HERE/lib/heal.sh"
# shellcheck source=../lib/probe.sh
. "$HERE/lib/probe.sh"
# shellcheck source=../lib/canary.sh
[ -r "$HERE/lib/canary.sh" ] && . "$HERE/lib/canary.sh"   # an older install has no canary.sh, and the tick then skips it

"$G_MKDIR" -p "$STATE_DIR" "$FLAG_DIR" 2>/dev/null

tick() {
  collect_all
  publish "kiosk/$GUARDIAN_ROOM/health" "$(health_line)"
  heal_cycle
  if type canary_cycle >/dev/null 2>&1; then canary_cycle; fi
}

# Loop self-supervision. The Guardian never signals a pid it remembers: under launchd a process-group kill of the job (or a SIGKILL of main)
# takes main down without running a trap, and the loops sit in groups of their own. So each loop checks, once per second, that main is still
# its parent. When main is gone the loop signals ONLY its own process group (signal target 0 = the caller's group, which it leads) and exits.
# MAIN_PID is set by run(); a loop started with it empty does not run.
MAIN_PID=""
LOOP_ME=""
LOOP_MISS=0

# Run first inside a loop subshell. Job control off, so the loop's pipeline stays in the loop's group; LOOP_ME = this subshell's pid.
# Fails closed: no MAIN_PID means no supervisor to watch for, so the loop does not run.
loop_init() {
  set +m
  if [ -z "$MAIN_PID" ]; then audit "loop exits: MAIN_PID empty"; exit 0; fi
  LOOP_ME="$(g_ppid)"
  LOOP_MISS=0
}

# 0 while main is alive and is still this loop's parent (a reused main pid does not pass: the parent link is checked, not just kill -0).
# An empty ps read (a failed fork) is not "main gone": it counts as a miss and the loop leaves only after 3 misses in a row.
# After a 3-strike exit nothing restarts the loop: this fails safe (no control messages = stale = shadow, never heal). GUARDIAN_PS (a fake ps) is a library-test seam and is never read in run mode.
loop_parent_ok() {
  local info ps_cmd
  [ -n "$MAIN_PID" ] || return 1
  kill -0 "$MAIN_PID" 2>/dev/null || return 1
  ps_cmd="$G_PS"
  [ "${G_RUNMODE:-}" != 1 ] && [ "${GUARDIAN_TESTMODE:-}" = 1 ] && [ -n "${GUARDIAN_PS:-}" ] && ps_cmd="$GUARDIAN_PS"
  info="$("$ps_cmd" -o ppid= -p "$LOOP_ME" 2>/dev/null | "$G_TR" -d ' ')"
  if [ -z "$info" ]; then
    LOOP_MISS=$((LOOP_MISS + 1))
    if [ "$LOOP_MISS" -ge 3 ]; then audit "loop exits: 3 empty ps reads in a row"; return 1; fi
    return 0
  fi
  LOOP_MISS=0
  [ "$info" = "$MAIN_PID" ]
}

# Main is gone: stop this loop's own tree and exit. Group signal only when this subshell is provably its group's leader;
# otherwise only the current background job (a job-table reference, never a bare pid) is signalled.
loop_orphaned() {
  local pg
  pg="$("$G_PS" -o pgid= -p "$LOOP_ME" 2>/dev/null | "$G_TR" -d ' ')"
  if [ -n "$LOOP_ME" ] && [ "$pg" = "$LOOP_ME" ]; then
    trap '' TERM
    kill -TERM 0 2>/dev/null
  else
    kill %% 2>/dev/null
  fi
  exit 0
}

# Sleep $1 s in 1 s slices, leaving as soon as main is gone.
loop_nap() {
  local n="$1"
  while [ "$n" -gt 0 ]; do
    loop_parent_ok || loop_orphaned
    sleep 1; n=$((n - 1))
  done
}

# Run one pipeline job in the background and watch it: returns when it ends; leaves the loop if main goes away first.
loop_watch() {
  local pp="$1"
  while kill -0 "$pp" 2>/dev/null; do
    loop_parent_ok || loop_orphaned
    sleep 1
  done
  wait "$pp" 2>/dev/null
}

subscriber_loop() {
  local topic payload backoff=2
  [ -n "$GUARDIAN_SUBSCRIBE_CMD" ] || return 0
  loop_init
  while :; do
    loop_parent_ok || loop_orphaned
    { g_conf_cmd "$GUARDIAN_SUBSCRIBE_CMD" "$GUARDIAN_ROOM" </dev/null 2>/dev/null | while IFS="$(printf '\t')" read -r topic payload; do
      handle_message "$topic" "$payload"
    done; } </dev/null &
    loop_watch $!
    audit "subscriber exited; retry in ${backoff}s"
    loop_nap "$backoff"
    [ "$backoff" -lt 60 ] && backoff=$((backoff * 2))
  done
}

# Store one control line atomically (tmp + mv): line 1 = receive epoch, line 2 = payload.
control_store() {
  local tmp="$STATE_DIR/control.last.tmp.$$"
  "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null
  { printf '%s\n' "$(now_epoch)"; printf '%s\n' "$1"; } >"$tmp" && "$G_MV" -f "$tmp" "$STATE_DIR/control.last"
}

# NUL -> 0x01 filter. tr -u (BSD tr: unbuffered) matters: a plain tr holds a message back on a pipe until EOF.
nul_to_soh() {
  LC_ALL=C "$G_TR" -u '\000' '\001'
}

# Read control lines from stdin with a length cap (R10). A line longer than CONTROL_LINE_MAX (4200) bytes is never stored as a line:
# the marker "overlong" is stored instead (not the control form = killed) and the rest of that line is read in 4096-byte chunks and dropped up to its next LF.
# Memory stays bounded by one chunk, however long the line is. A partial last line (no LF at EOF) is not stored.
control_pump() {
  local LC_ALL=C line junk rc
  while :; do
    IFS= read -r -n "$((CONTROL_LINE_MAX + 1))" line; rc=$?
    if [ "${#line}" -gt "$CONTROL_LINE_MAX" ]; then
      control_store "overlong"
      line=""
      while :; do
        IFS= read -r -n 4096 junk; rc=$?
        [ "$rc" -eq 0 ] || return 0
        [ "${#junk}" -ge 4096 ] || break
      done
      continue
    fi
    [ "$rc" -eq 0 ] || return 0
    [ -n "$line" ] && control_store "$line"
  done
}

# Kiosk's own subscription to guardian/control. Same backoff pattern as subscriber_loop.
control_loop() {
  local backoff=2
  [ -n "$GUARDIAN_CONTROL_SUB_CMD" ] || return 0
  loop_init
  while :; do
    # bash drops NUL on read, which would turn "fa<NUL>lse" into a clean "false": map NUL to 0x01 first so the raw-byte check on control.last kills it.
    loop_parent_ok || loop_orphaned
    { g_conf_cmd "$GUARDIAN_CONTROL_SUB_CMD" "$GUARDIAN_ROOM" "$GUARDIAN_CONTROL_TOPIC" </dev/null 2>/dev/null | nul_to_soh | control_pump; } </dev/null &
    loop_watch $!
    audit "control subscriber exited; retry in ${backoff}s"
    loop_nap "$backoff"
    [ "$backoff" -lt 60 ] && backoff=$((backoff * 2))
  done
}

run() {
  local t0 t1
  audit "guardian start version=$GUARDIAN_VERSION"
  [ -n "$GUARDIAN_ROOM" ] || { audit "running KILLED: no room (guardian.conf has no valid GUARDIAN_ROOM)"; echo "GUARDIAN_ROOM not set" >&2; exit 2; }
  if [ "${G_CONF_BAD:-}" = 1 ]; then audit "guardian.conf rejected: running KILLED (shadow, no actions); health continues"; fi
  MAIN_PID="$(g_ppid)"
  [ -n "$MAIN_PID" ] || MAIN_PID=$$
  trap 'exit 0' TERM INT HUP
  # Job control gives each loop a process group of its own, which the loop signals itself (see loop_orphaned) when main is gone.
  # Main sends no signal to any pid: after TERM, an exit or a SIGKILL the loops notice within about 2 s and stop on their own.
  set -m
  subscriber_loop &
  control_loop &
  set +m
  while :; do
    t0="$(now_epoch)"
    flag_poll
    tick
    t1="$(now_epoch)"
    # sleep in the background and wait, so TERM/INT is handled at once
    if [ "$((t1 - t0))" -lt 10 ]; then sleep $((10 - (t1 - t0))) & wait $!; fi
  done
}

# check: the state the kill switch would give right now (same parse the actions use). Prints "killswitch=engaged|clear mode=shadow|heal why=<reason>".
check() {
  local ks=clear
  flag_fetch
  killswitch_engaged && ks=engaged
  echo "killswitch=$ks mode=$(current_mode) why=${CTRL_WHY:-none}"
}

# Run mode: every function is readonly before anything is dispatched, so nothing defined later (or imported) can replace one.
if [ "${G_RUNMODE:-}" = 1 ]; then
  while read -r _ _ G_FN; do readonly -f "$G_FN" 2>/dev/null; done < <(declare -F)
fi

case "$G_MODE_ARG" in
  run) run ;;
  check) check ;;
  once) flag_fetch; tick ;;
  handle) handle_message "$2" "$3" ;;
  *) echo "usage: guardian.sh run|check|once|handle" >&2; exit 2 ;;
esac
