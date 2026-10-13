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
    bash -c "$GUARDIAN_SUBSCRIBE_CMD" _ "$GUARDIAN_ROOM" 2>/dev/null | while IFS="$(printf '\t')" read -r topic payload; do
      handle_message "$topic" "$payload"
    done
    audit "subscriber exited; retry in ${backoff}s"
    sleep "$backoff"
    [ "$backoff" -lt 60 ] && backoff=$((backoff * 2))
  done
}

run() {
  local last_flag=0 t0 t1 sub
  [ -n "$GUARDIAN_ROOM" ] || { echo "GUARDIAN_ROOM not set" >&2; exit 2; }
  audit "guardian start version=$GUARDIAN_VERSION"
  subscriber_loop & sub=$!
  trap 'kill $sub 2>/dev/null; exit 0' TERM INT
  while :; do
    t0="$(now_epoch)"
    if [ "$((t0 - last_flag))" -ge 60 ]; then flag_fetch; last_flag="$t0"; fi
    tick
    t1="$(now_epoch)"
    [ "$((t1 - t0))" -lt 10 ] && sleep $((10 - (t1 - t0)))
  done
}

case "${1:-run}" in
  run) run ;;
  once) flag_fetch; tick ;;
  handle) handle_message "$2" "$3" ;;
  *) echo "usage: guardian.sh run|once|handle" >&2; exit 2 ;;
esac
