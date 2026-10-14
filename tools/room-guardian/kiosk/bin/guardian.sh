#!/bin/bash
# Kiosk Guardian main loop (launchd user agent, runs as the console user).
#   guardian.sh run      loop forever: health line every 10 s, heal cycle, subscriber child
#   guardian.sh once     one tick (collect, publish health, heal cycle) and exit
#   guardian.sh handle <topic> <payload>   answer one message (used by tests)
# Config: $GUARDIAN_CONF or $HOME/Library/Application Support/EvenScribe/Guardian/guardian.conf (sourced, not in git).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="${GUARDIAN_CONF:-${GUARDIAN_HOME:-$HOME/Library/Application Support/EvenScribe/Guardian}/guardian.conf}"
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"
# shellcheck source=../lib/common.sh
. "$HERE/lib/common.sh"
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

mkdir -p "$STATE_DIR" "$FLAG_DIR" 2>/dev/null

tick() {
  collect_all
  publish "kiosk/$GUARDIAN_ROOM/health" "$(health_line)"
  heal_cycle
}

subscriber_loop() {
  local topic payload backoff=2
  [ -n "$GUARDIAN_SUBSCRIBE_CMD" ] || return 0
  while :; do
    bash -c "$GUARDIAN_SUBSCRIBE_CMD" _ "$GUARDIAN_ROOM" </dev/null 2>/dev/null | while IFS="$(printf '\t')" read -r topic payload; do
      handle_message "$topic" "$payload"
    done
    audit "subscriber exited; retry in ${backoff}s"
    sleep "$backoff"
    [ "$backoff" -lt 60 ] && backoff=$((backoff * 2))
  done
}

# Store one control line atomically (tmp + mv): line 1 = receive epoch, line 2 = payload.
control_store() {
  local tmp="$STATE_DIR/control.last.tmp.$$"
  mkdir -p "$STATE_DIR" 2>/dev/null
  { printf '%s\n' "$(now_epoch)"; printf '%s\n' "$1"; } >"$tmp" && mv -f "$tmp" "$STATE_DIR/control.last"
}

# Kiosk's own subscription to guardian/control. Same backoff pattern as subscriber_loop.
control_loop() {
  local line backoff=2
  [ -n "$GUARDIAN_CONTROL_SUB_CMD" ] || return 0
  while :; do
    bash -c "$GUARDIAN_CONTROL_SUB_CMD" _ "$GUARDIAN_ROOM" "$GUARDIAN_CONTROL_TOPIC" </dev/null 2>/dev/null | while IFS= read -r line; do
      [ -n "$line" ] && control_store "$line"
    done
    audit "control subscriber exited; retry in ${backoff}s"
    sleep "$backoff"
    [ "$backoff" -lt 60 ] && backoff=$((backoff * 2))
  done
}

# Kill the loops' process groups. Idempotent; runs on TERM/INT/HUP and on every exit of main.
LOOP_PIDS=""
WATCHDOG_PID=""
stop_loops() {
  local p
  [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null
  for p in $LOOP_PIDS; do kill -TERM -- "-$p" 2>/dev/null; kill "$p" 2>/dev/null; done
  LOOP_PIDS=""
}

run() {
  local t0 t1 sub ctl main=$$
  [ -n "$GUARDIAN_ROOM" ] || { echo "GUARDIAN_ROOM not set" >&2; exit 2; }
  audit "guardian start version=$GUARDIAN_VERSION"
  trap stop_loops EXIT
  trap 'exit 0' TERM INT HUP
  # Job control gives each loop its own process group, so TERM reaches the pipeline children (bash -c, ssh) too.
  set -m
  subscriber_loop & sub=$!
  control_loop & ctl=$!
  set +m
  LOOP_PIDS="$sub $ctl"
  # SIGKILL of main cannot run a trap, and the loops are outside the launchd job's group: a watchdog kills them when main is gone.
  ( while kill -0 "$main" 2>/dev/null; do sleep 1; done
    kill -TERM -- "-$sub" "-$ctl" 2>/dev/null; kill "$sub" "$ctl" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  WATCHDOG_PID=$!
  while :; do
    t0="$(now_epoch)"
    flag_poll
    tick
    t1="$(now_epoch)"
    # sleep in the background and wait, so TERM/INT is handled at once
    if [ "$((t1 - t0))" -lt 10 ]; then sleep $((10 - (t1 - t0))) & wait $!; fi
  done
}

case "${1:-run}" in
  run) run ;;
  once) flag_fetch; tick ;;
  handle) handle_message "$2" "$3" ;;
  *) echo "usage: guardian.sh run|once|handle" >&2; exit 2 ;;
esac
