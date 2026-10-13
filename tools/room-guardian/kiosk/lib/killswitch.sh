#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: kill switch and mode (spec 2.4 last paragraph, 2.5, G8).
# Control comes from pipe topic guardian/control (C4 ruling); the transport command is injectable and gets the room as $1 and the topic as $2.
# Per-kiosk flag: file $FLAG_DIR/heal-off. Fleet-wide flag and per-room mode: fetched from the Mini
# each minute through GUARDIAN_FLAG_CMD, which prints lines "fleet=on|off" and "mode=shadow|heal".
# No command, a failed command, a timeout, a stale cache, or anything but fleet=on means heal OFF.

FLAG_CACHE="$STATE_DIR/flags.cache"

flag_fetch() {
  local out="$STATE_DIR/flags.fetch" now rc
  mkdir -p "$STATE_DIR" "$FLAG_DIR" 2>/dev/null
  now="$(now_epoch)"
  if [ -z "$GUARDIAN_FLAG_CMD" ]; then
    printf '%s\nfleet=unreachable\n' "$now" >"$FLAG_CACHE"; return 1
  fi
  run_capped 5 "$out" bash -c "$GUARDIAN_FLAG_CMD" _ "$GUARDIAN_ROOM" "$GUARDIAN_CONTROL_TOPIC"
  rc=$?
  if [ "$rc" -ne 0 ] || ! grep -q '^fleet=' "$out" 2>/dev/null; then
    printf '%s\nfleet=unreachable\n' "$now" >"$FLAG_CACHE"; return 1
  fi
  { printf '%s\n' "$now"; grep -E '^(fleet|mode)=' "$out"; } >"$FLAG_CACHE"
  return 0
}

# 0 (true) when healing is blocked. Cheap: reads two files, so it is called before every action.
killswitch_engaged() {
  local fetched now fleet
  [ -e "$FLAG_DIR/heal-off" ] && return 0
  [ -r "$FLAG_CACHE" ] || return 0
  fetched="$(sed -n '1p' "$FLAG_CACHE")"
  now="$(now_epoch)"
  case "$fetched" in ''|*[!0-9]*) return 0 ;; esac
  [ "$((now - fetched))" -le "$FLAG_MAX_AGE_S" ] || return 0
  fleet="$(sed -n 's/^fleet=//p' "$FLAG_CACHE" | head -n1)"
  [ "$fleet" = "on" ] || return 0
  return 1
}

# "heal" only when the Mini says so and the kill switch is clear. Everything else is shadow.
current_mode() {
  local m
  if killswitch_engaged; then echo shadow; return; fi
  m="$(sed -n 's/^mode=//p' "$FLAG_CACHE" 2>/dev/null | head -n1)"
  [ "$m" = "heal" ] && echo heal || echo shadow
}
