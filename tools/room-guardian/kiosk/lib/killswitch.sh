#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: kill switch and mode (spec 2.4 last paragraph, 2.5, G8).
# Control comes from pipe topic guardian/control (C4 ruling); the transport command is injectable and gets the room as $1 and the topic as $2.
# Per-kiosk flag: file $FLAG_DIR/heal-off. Fleet-wide flag and per-room mode: fetched from the Mini
# every FLAG_FETCH_S through GUARDIAN_FLAG_CMD (old path), or derived from control.last (GUARDIAN_CONTROL_SUB_CMD, no message for CONTROL_STALE_S = killed), which prints lines "fleet=on|off" and "mode=shadow|heal".
# No command, a failed command, a timeout, a stale cache, or anything but fleet=on means heal OFF.

FLAG_CACHE="$STATE_DIR/flags.cache"

CONTROL_LAST="$STATE_DIR/control.last"

# Print the top-level keys of a JSON object read on stdin, one "key<TAB>raw value" line each (values trimmed).
# Prints a line starting with ERR when the text is not one balanced object (open string, depth, junk, escaped key).
control_top_keys() {
  awk '
  BEGIN { RS = "\001" }
  { s = $0 }
  END {
    n = length(s); depth = 0; instr = 0; esc = 0; mode = "O"; err = 0; done = 0; key = ""; val = ""; cur = ""
    for (i = 1; i <= n && !err; i++) {
      c = substr(s, i, 1)
      if (done) { if (c !~ /[ \t\r\n]/) err = 1; continue }
      if (instr) {
        if (mode == "V") val = val c
        if (esc) { esc = 0; if (depth == 1 && mode == "K") err = 1 }
        else if (c == "\\") { esc = 1; if (depth == 1 && mode == "K") err = 1 }
        else if (c == "\"") {
          instr = 0
          if (depth == 1 && mode == "K") { key = cur; mode = "C" }
        } else cur = cur c
        continue
      }
      if (mode == "O") {
        if (c ~ /[ \t\r\n]/) continue
        if (c == "{") { depth = 1; mode = "K"; continue }
        err = 1; continue
      }
      if (c == "\"") { instr = 1; cur = ""; if (mode == "V") val = val c; continue }
      if (depth == 1 && mode == "K") {
        if (c ~ /[ \t\r\n]/) continue
        if (c == "}") { depth = 0; done = 1; continue }
        err = 1; continue
      }
      if (depth == 1 && mode == "C") {
        if (c ~ /[ \t\r\n]/) continue
        if (c == ":") { mode = "V"; val = ""; continue }
        err = 1; continue
      }
      # mode V (value of a top-level key)
      if (c == "{" || c == "[") { depth++; val = val c; continue }
      if (c == "}" || c == "]") {
        if (depth == 1) {
          if (c == "]") { err = 1; continue }
          emit(key, val); depth = 0; done = 1; continue
        }
        depth--; val = val c; continue
      }
      if (c == "," && depth == 1) { emit(key, val); mode = "K"; continue }
      val = val c
    }
    if (err || instr || depth != 0 || !done) { print "ERR"; exit }
  }
  function emit(k, v) { gsub(/^[ \t\r\n]+|[ \t\r\n]+$/, "", v); gsub(/\t/, " ", k); print k "\t" v }
  '
}

# Parse $CONTROL_LAST (line 1 = receive epoch, line 2 = payload). Sets CTRL_FLEET (on|unreachable),
# CTRL_MODE (shadow|heal), CTRL_WHY (ok|missing|unparseable|stale|kill|skew) and CTRL_AGE (receive age, or empty).
# Pure bash/sed. Fail closed: anything but a fresh payload with exactly one top-level "kill": false means killed.
# Top-level only: the modes object is stripped first, then "kill" and "ts" must each occur at most once ("kill" exactly once).
# Optional top-level integer "ts" (publish epoch): stale when now - ts > CONTROL_STALE_S; more than 30 s ahead = killed.
# Stale latches on the receive epoch: it stays stale until a message arrives with a DIFFERENT receive epoch, even if the clock steps back.
control_parse() {
  local opens closes recv payload now room modes top kill ts nk nm nts latch keys
  CTRL_FLEET=unreachable; CTRL_MODE=shadow; CTRL_WHY=missing; CTRL_AGE=""
  [ -r "$CONTROL_LAST" ] || return 1
  recv="$(sed -n '1p' "$CONTROL_LAST" 2>/dev/null)"
  payload="$(sed -n '2p' "$CONTROL_LAST" 2>/dev/null)"
  now="$(now_epoch)"
  case "$recv" in ''|*[!0-9]*) CTRL_WHY=unparseable; return 1 ;; esac
  [ "${#recv}" -le 15 ] || { CTRL_WHY=unparseable; return 1; }
  CTRL_AGE=$((10#$now - 10#$recv))
  if [ "$CTRL_AGE" -lt -2 ]; then CTRL_WHY=unparseable; return 1; fi
  latch="$(cat "$STATE_DIR/control_latch" 2>/dev/null)"
  if [ "$latch" = "$recv" ]; then CTRL_WHY=stale; return 1; fi
  if [ "$CTRL_AGE" -gt "$CONTROL_STALE_S" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null; printf '%s\n' "$recv" >"$STATE_DIR/control_latch"
    CTRL_WHY=stale; return 1
  fi
  case "$payload" in '{'*'}') ;; *) CTRL_WHY=unparseable; return 1 ;; esac
  opens="$(printf "%s" "$payload" | tr -cd "{" | wc -c | tr -d " ")"; closes="$(printf "%s" "$payload" | tr -cd "}" | wc -c | tr -d " ")"
  if [ "$opens" != "$closes" ]; then CTRL_WHY=unparseable; return 1; fi
  top="$(printf '%s' "$payload" | sed -E 's/"modes"[[:space:]]*:[[:space:]]*\{[^}]*\}//')"
  nk="$(printf '%s' "$top" | grep -o '"kill"' | wc -l | tr -d ' ')"
  nts="$(printf '%s' "$top" | grep -o '"ts"' | wc -l | tr -d ' ')"
  if [ "$nk" != "1" ] || [ "$nts" -gt 1 ]; then CTRL_WHY=unparseable; return 1; fi
  # Structural pass: real top-level keys only (nesting and strings tracked). A missing top-level "kill" = killed, wherever a nested one appears.
  keys="$(printf '%s' "$payload" | control_top_keys)"
  case "$keys" in ERR*|'') CTRL_WHY=unparseable; return 1 ;; esac
  nk="$(printf '%s\n' "$keys" | awk -F'\t' '$1=="kill"{n++} END{print n+0}')"
  nm="$(printf '%s\n' "$keys" | awk -F'\t' '$1=="modes"{n++} END{print n+0}')"
  nts="$(printf '%s\n' "$keys" | awk -F'\t' '$1=="ts"{n++} END{print n+0}')"
  if [ "$nk" != "1" ] || [ "$nm" -gt 1 ] || [ "$nts" -gt 1 ]; then CTRL_WHY=unparseable; return 1; fi
  kill="$(printf '%s\n' "$keys" | awk -F'\t' '$1=="kill"{print $2}')"
  if [ "$kill" = "true" ]; then CTRL_WHY="kill"; return 1; fi
  if [ "$kill" != "false" ]; then CTRL_WHY=unparseable; return 1; fi
  if [ "$nts" = "1" ]; then
    ts="$(printf '%s\n' "$keys" | awk -F'\t' '$1=="ts"{print $2}')"
    case "$ts" in ''|*[!0-9]*) CTRL_WHY=unparseable; return 1 ;; esac
    if [ "${#ts}" -gt 15 ]; then CTRL_WHY=unparseable; return 1; fi
    ts=$((10#$ts))
    if [ "$((ts - now))" -gt 30 ]; then CTRL_WHY=skew; return 1; fi
    if [ "$((now - ts))" -gt "$CONTROL_STALE_S" ]; then
      mkdir -p "$STATE_DIR" 2>/dev/null; printf '%s\n' "$recv" >"$STATE_DIR/control_latch"
      CTRL_WHY=stale; return 1
    fi
  fi
  CTRL_FLEET=on; CTRL_WHY=ok
  # shellcheck disable=SC2016
  room="$(printf '%s' "$GUARDIAN_ROOM" | sed 's/[][\.*^$(){}?+|/]/\\&/g')"
  modes="$(printf '%s\n' "$keys" | awk -F'\t' '$1=="modes"{print $2}')"
  if printf '%s' "$modes" | grep -qE '"'"$room"'"[[:space:]]*:[[:space:]]*"heal"'; then CTRL_MODE=heal; fi
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
