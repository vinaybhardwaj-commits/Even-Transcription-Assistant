#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: kill switch and mode (spec 2.4 last paragraph, 2.5, G8).
# Control comes from pipe topic guardian/control (C4 ruling); the transport command is injectable and gets the room as $1 and the topic as $2.
# Per-kiosk flag: file $FLAG_DIR/heal-off. Fleet-wide flag and per-room mode: fetched from the Mini
# every FLAG_FETCH_S through GUARDIAN_FLAG_CMD (old path), or derived from control.last (GUARDIAN_CONTROL_SUB_CMD, no message for CONTROL_STALE_S = killed), which prints lines "fleet=on|off" and "mode=shadow|heal".
# No command, a failed command, a timeout, a stale cache, or anything but fleet=on means heal OFF.

FLAG_CACHE="$STATE_DIR/flags.cache"

CONTROL_LAST="$STATE_DIR/control.last"

# Parse $CONTROL_LAST (line 1 = receive epoch, line 2 = payload). Sets CTRL_FLEET (on|unreachable),
# CTRL_MODE (shadow|heal), CTRL_WHY (ok|missing|unparseable|stale|kill|skew) and CTRL_AGE (receive age, or empty).
# No JSON scanner. The Mini publishes exactly one form (json.dumps with sort_keys and default separators), and only that form is accepted:
#   {"kill": true|false, "modes": {"<room>": "shadow|heal", ...}, "ts": <epoch>}
# Everything else is killed. Order of checks:
#   1. raw bytes of the FILE, before any variable read (bash drops NUL): the payload line at most CONTROL_MAX_BYTES (4096) and the file at most that plus 17, exactly 2 lines,
#      every byte in 0x20-0x7E or the newline, ending in a newline;
#   2. line 1 matches ^[1-9][0-9]{0,14}$ (read base 10); stale/latch/skew rules on the receive epoch and on "ts";
#   3. line 2 matches ONE anchored regex under LC_ALL=C.
# kill is the captured literal; mode is heal only when this room's key (valid room name) appears once in modes with "heal"; twice = killed.
# Stale latches on the receive epoch: it stays stale until a message arrives with a DIFFERENT receive epoch, even if the clock steps back.
CONTROL_RE='^\{"kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$'
CONTROL_RECV_RE='^[1-9][0-9]{0,14}$'
CONTROL_ROOM_RE='^[a-z0-9_-]{1,64}$'

control_parse() {
  local LC_ALL=C
  local recv payload now latch size bad nl ts modes_part pat rest cnt
  CTRL_FLEET=unreachable; CTRL_MODE=shadow; CTRL_WHY=missing; CTRL_AGE=""
  [ -r "$CONTROL_LAST" ] || return 1
  # 1. raw bytes, as a file
  size="$(wc -c <"$CONTROL_LAST" 2>/dev/null | tr -d " ")"
  case "$size" in ""|*[!0-9]*) CTRL_WHY=unparseable; return 1 ;; esac
  if [ "$size" -gt "$((${CONTROL_MAX_BYTES:-4096} + 17))" ]; then CTRL_WHY=unparseable; return 1; fi
  bad="$(LC_ALL=C tr -d '\n\040-\176' <"$CONTROL_LAST" 2>/dev/null | wc -c | tr -d " ")"
  nl="$(wc -l <"$CONTROL_LAST" 2>/dev/null | tr -d " ")"
  if [ "$bad" != "0" ] || [ "$nl" != "2" ] || [ "$(tail -c 1 "$CONTROL_LAST" 2>/dev/null | wc -l | tr -d " ")" != "1" ]; then CTRL_WHY=rawbytes; return 1; fi
  recv="$(sed -n '1p' "$CONTROL_LAST" 2>/dev/null)"
  payload="$(sed -n '2p' "$CONTROL_LAST" 2>/dev/null)"
  now="$(now_epoch)"
  # the payload line itself is capped (the file cap above is the payload cap plus a 15-digit epoch and 2 newlines)
  if [ "${#payload}" -gt "${CONTROL_MAX_BYTES:-4096}" ]; then CTRL_WHY=unparseable; return 1; fi
  # 2. receive epoch
  [[ $recv =~ $CONTROL_RECV_RE ]] || { CTRL_WHY=unparseable; return 1; }
  CTRL_AGE=$((10#$now - 10#$recv))
  if [ "$CTRL_AGE" -lt -2 ]; then CTRL_WHY=unparseable; return 1; fi
  latch="$(cat "$STATE_DIR/control_latch" 2>/dev/null)"
  if [ "$latch" = "$recv" ]; then CTRL_WHY=stale; return 1; fi
  if [ "$CTRL_AGE" -gt "$CONTROL_STALE_S" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null; printf '%s\n' "$recv" >"$STATE_DIR/control_latch"
    CTRL_WHY=stale; return 1
  fi
  # 3. the payload: one anchored regex
  [[ $payload =~ $CONTROL_RE ]] || { CTRL_WHY=unparseable; return 1; }
  case "$payload" in '{"kill": true,'*) CTRL_WHY="kill"; return 1 ;; '{"kill": false,'*) ;; *) CTRL_WHY=unparseable; return 1 ;; esac
  ts="${payload##*\"ts\": }"; ts="${ts%\}}"
  ts=$((10#$ts))
  if [ "$((ts - 10#$now))" -gt 30 ]; then CTRL_WHY=skew; return 1; fi
  if [ "$((10#$now - ts))" -gt "$CONTROL_STALE_S" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null; printf '%s\n' "$recv" >"$STATE_DIR/control_latch"
    CTRL_WHY=stale; return 1
  fi
  CTRL_FLEET=on; CTRL_WHY=ok
  if [[ $GUARDIAN_ROOM =~ $CONTROL_ROOM_RE ]]; then
    modes_part="${payload#*\"modes\": }"; modes_part="${modes_part%, \"ts\": *}"
    pat="\"$GUARDIAN_ROOM\": "
    rest="${modes_part//"$pat"/}"
    cnt=$(( (${#modes_part} - ${#rest}) / ${#pat} ))
    if [ "$cnt" -gt 1 ]; then CTRL_FLEET=unreachable; CTRL_WHY=unparseable; return 1; fi
    case "$modes_part" in *"\"$GUARDIAN_ROOM\": \"heal\""*) CTRL_MODE=heal ;; esac
  fi
  return 0
}

# One audit line per state change (on <-> killed, or a new reason for being killed).
control_audit_change() {
  local f="$STATE_DIR/control_state" prev cur="$CTRL_FLEET:$CTRL_WHY"
  prev="$(cat "$f" 2>/dev/null)"
  [ "$prev" = "$cur" ] && return 0
  printf '%s\n' "$cur" >"$f"
  audit "control state ${prev:-none} -> $cur age=${CTRL_AGE:-none}"
}

flag_fetch() {
  local out="$STATE_DIR/flags.fetch" now rc
  mkdir -p "$STATE_DIR" "$FLAG_DIR" 2>/dev/null
  now="$(now_epoch)"
  if [ -n "$GUARDIAN_CONTROL_SUB_CMD" ]; then
    control_parse; rc=$?
    control_audit_change
    printf '%s\nfleet=%s\nmode=%s\n' "$now" "$CTRL_FLEET" "$CTRL_MODE" >"$FLAG_CACHE.tmp" && mv "$FLAG_CACHE.tmp" "$FLAG_CACHE"
    return "$rc"
  fi
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

# 0 (true) when healing is blocked. Cheap: reads local files, so it is called before every action.
killswitch_engaged() {
  local fetched now fleet
  [ -e "$FLAG_DIR/heal-off" ] && return 0
  [ -r "$FLAG_CACHE" ] || return 0
  fetched="$(sed -n '1p' "$FLAG_CACHE")"
  now="$(now_epoch)"
  case "$fetched" in ""|*[!0-9]*) return 0 ;; esac
  [ "${#fetched}" -le 15 ] || return 0
  [ "$((10#$now - 10#$fetched))" -le "$FLAG_MAX_AGE_S" ] || return 0
  fleet="$(sed -n 's/^fleet=//p' "$FLAG_CACHE" | head -n1)"
  [ "$fleet" = "on" ] || return 0
  # With the control subscription the live file is re-read here, so staleness engages without waiting for the next fetch.
  if [ -n "$GUARDIAN_CONTROL_SUB_CMD" ]; then control_parse || return 0; fi
  return 1
}

# "heal" only when the Mini says so and the kill switch is clear. Everything else is shadow.
current_mode() {
  local m
  if killswitch_engaged; then echo shadow; return; fi
  # With the control subscription the live parsed mode is used, so heal -> shadow needs no fetch.
  if [ -n "$GUARDIAN_CONTROL_SUB_CMD" ]; then control_parse || { echo shadow; return; }; echo "$CTRL_MODE"; return; fi
  m="$(sed -n 's/^mode=//p' "$FLAG_CACHE" 2>/dev/null | head -n1)"
  [ "$m" = "heal" ] && echo heal || echo shadow
}

# Fetch at most once per FLAG_FETCH_S. The cache max age (FLAG_MAX_AGE_S) is longer, so one missed fetch is not yet OFF.
flag_poll() {
  local f="$STATE_DIR/flag_last" last now
  now="$(now_epoch)"; last="$(cat "$f" 2>/dev/null)"
  case "$last" in ''|*[!0-9]*) last="" ;; esac
  [ "${#last}" -le 15 ] || last=""
  if [ -z "$last" ] || [ "$((10#$now - 10#$last))" -ge "$FLAG_FETCH_S" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null
    printf '%s\n' "$now" >"$f"
    flag_fetch
  fi
}
