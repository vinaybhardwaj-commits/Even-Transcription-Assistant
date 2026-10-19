#!/bin/bash
# shellcheck disable=SC2034,SC2154
# Kiosk Guardian: kill switch and mode (spec 2.4 last paragraph, 2.5, G8).
# Control comes from pipe topic guardian/control (C4 ruling); the transport command is injectable and gets the room as $1 and the topic as $2.
# Per-kiosk flag: file $FLAG_DIR/heal-off. Fleet-wide flag and per-room mode: fetched from the Mini
# every FLAG_FETCH_S through GUARDIAN_FLAG_CMD (old path, library tests only: run mode never uses it, R12), or derived from control.last (GUARDIAN_CONTROL_SUB_CMD, no message for CONTROL_STALE_S = killed), which prints lines "fleet=on|off" and "mode=shadow|heal".
# No command, a failed command, a timeout, a stale cache, or anything but fleet=on means heal OFF.

FLAG_CACHE="$STATE_DIR/flags.cache"

CONTROL_LAST="$STATE_DIR/control.last"

# Parse $CONTROL_LAST (line 1 = receive epoch, line 2 = payload). Sets CTRL_FLEET (on|unreachable),
# CTRL_MODE (shadow|heal), CTRL_WHY (ok|missing|unparseable|stale|kill|skew|conf|constants) and CTRL_AGE (receive age, or empty).
# No JSON scanner. The Mini publishes exactly one form (json.dumps with sort_keys and default separators), and only that form is accepted:
#   {"kill": true|false, "modes": {"<room>": "shadow|heal", ...}, "ts": <epoch>}
# Everything else is killed. Order of checks:
#   1. raw bytes of the FILE, before any variable read (bash drops NUL): the payload line at most CONTROL_MAX_BYTES (4096) and the file at most that plus 17, exactly 2 lines,
#      every byte in 0x20-0x7E or the newline, ending in a newline;
#   2. line 1 matches ^[1-9][0-9]{0,14}$ (read base 10); stale/latch/skew rules on the receive epoch and on "ts";
#   3. line 2 matches ONE anchored regex under LC_ALL=C.
# modes keys must be strictly ascending (bytewise) and unique, for every room; anything else is killed.
# kill is the captured literal; mode is heal only when this room's key (valid room name) appears once in modes with "heal"; twice = killed.
# Stale latches on the receive epoch: it stays stale until a message arrives with a DIFFERENT receive epoch, even if the clock steps back.
CONTROL_RE='^\{"kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$'
# 2.4 d' (release order: this kiosk first, the router second). The payload may ALSO be the new form, whose first key is consult_open (json.dumps sort_keys puts it first):
#   {"consult_open": {"<room>": true|false, ...}, "kill": true|false, "modes": {...}, "ts": <epoch>}
# kill, modes and ts are parsed IDENTICALLY in both forms: the new form is split into its consult_open value and an old-form remainder (the tail from ", "kill": " to the end),
# and the remainder goes through every check above and below unchanged.
# The consult hold (CTRL_HOLD) is "clear" ONLY on a fresh, new-form payload whose consult_open is well formed (<= 64 rooms, strictly ascending keys, true|false values) and holds this
# room's key exactly once with false. Everything else is "set": the old form, a missing, true, duplicate, malformed or oversize consult_open, a stale or killed control, an invalid room name.
# A malformed consult_open never changes kill or modes.
CONTROL_TAIL_RE=', "kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$'
CONTROL_CONSULT_RE='^\{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}$'
CONTROL_NEW_PFX='{"consult_open": '
CONTROL_RECV_RE='^[1-9][0-9]{0,14}$'
CONTROL_ROOM_RE='^[a-z0-9_-]{1,64}$'
if [ "${G_RUNMODE:-}" = 1 ]; then readonly CONTROL_RE CONTROL_TAIL_RE CONTROL_CONSULT_RE CONTROL_NEW_PFX CONTROL_LAST; fi   # R13 S6 (library tests may re-point CONTROL_LAST)

# 0 when the keys of a validated modes body ('"a": "heal", "b": "shadow"', no braces) are strictly ascending bytewise, so none repeats.
# One split on "," and two expansions per room (R11: the old pattern walk was quadratic). Keys and values hold no comma and no glob character (the regex proved it).
modes_keys_ascending() {
  local LC_ALL=C IFS=, item key prev=""
  for item in $1; do
    key="${item#*\"}"; key="${key%%\"*}"
    if [ -n "$prev" ] && ! [[ $key > $prev ]]; then return 1; fi
    prev="$key"
  done
  return 0
}

control_parse() {
  local LC_ALL=C
  local recv payload now latch size bad nl ts modes_part pat rest cnt body ctail frag=""
  CTRL_FLEET=unreachable; CTRL_MODE=shadow; CTRL_WHY=missing; CTRL_AGE=""; CTRL_HOLD="set"
  # R12: a bad guardian.conf or a safety constant that could not be pinned = killed, whatever control.last says
  if [ "${G_CONF_BAD:-}" = 1 ]; then CTRL_WHY=conf; return 1; fi
  if [ -n "${G_BAD_CONST:-}" ]; then CTRL_WHY=constants; return 1; fi
  # R15: the code tree or an ancestor of it is not safe (tree_check in conf.sh): killed, whatever control.last says
  if [ "${G_TREE_BAD:-}" = 1 ]; then CTRL_WHY=tree; return 1; fi
  [ -r "$CONTROL_LAST" ] || return 1
  # 1. raw bytes, as a file
  size="$("$G_WC" -c <"$CONTROL_LAST" 2>/dev/null | "$G_TR" -d " ")"
  case "$size" in ""|*[!0-9]*) CTRL_WHY=unparseable; return 1 ;; esac
  if [ "$size" -gt "$((CONTROL_MAX_BYTES + 17))" ]; then CTRL_WHY=unparseable; return 1; fi
  bad="$(LC_ALL=C "$G_TR" -d '\n\040-\176' <"$CONTROL_LAST" 2>/dev/null | "$G_WC" -c | "$G_TR" -d " ")"
  nl="$("$G_WC" -l <"$CONTROL_LAST" 2>/dev/null | "$G_TR" -d " ")"
  if [ "$bad" != "0" ] || [ "$nl" != "2" ] || [ "$("$G_TAIL" -c 1 "$CONTROL_LAST" 2>/dev/null | "$G_WC" -l | "$G_TR" -d " ")" != "1" ]; then CTRL_WHY=rawbytes; return 1; fi
  recv="$("$G_SED" -n '1p' "$CONTROL_LAST" 2>/dev/null)"
  payload="$("$G_SED" -n '2p' "$CONTROL_LAST" 2>/dev/null)"
  now="$(now_epoch)"
  # the payload line itself is capped (the file cap above is the payload cap plus a 15-digit epoch and 2 newlines)
  if [ "${#payload}" -gt "$CONTROL_MAX_BYTES" ]; then CTRL_WHY=unparseable; return 1; fi
  # 2. receive epoch
  [[ $recv =~ $CONTROL_RECV_RE ]] || { CTRL_WHY=unparseable; return 1; }
  CTRL_AGE=$((10#$now - 10#$recv))
  if [ "$CTRL_AGE" -lt -2 ]; then CTRL_WHY=unparseable; return 1; fi
  latch="$("$G_CAT" "$STATE_DIR/control_latch" 2>/dev/null)"
  if [ "$latch" = "$recv" ]; then CTRL_WHY=stale; return 1; fi
  # fail closed: written as "not (age <= limit)", so a comparison that errors counts as stale
  if ! [ "$CTRL_AGE" -le "$CONTROL_STALE_S" ]; then
    "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null; printf '%s\n' "$recv" >"$STATE_DIR/control_latch"
    CTRL_WHY=stale; return 1
  fi
  # 3a. (2.4 d') the new form: split off the consult_open value; the remainder is the old form and takes every check below unchanged.
  case "$payload" in
    "$CONTROL_NEW_PFX"*)
      body="${payload#"$CONTROL_NEW_PFX"}"
      if [[ $body =~ $CONTROL_TAIL_RE ]]; then
        ctail="${BASH_REMATCH[0]}"; frag="${body%"$ctail"}"
        payload="{${ctail#, }"
      fi ;;
  esac
  # 3. the payload: one anchored regex
  [[ $payload =~ $CONTROL_RE ]] || { CTRL_WHY=unparseable; return 1; }
  case "$payload" in '{"kill": true,'*) CTRL_WHY="kill"; return 1 ;; '{"kill": false,'*) ;; *) CTRL_WHY=unparseable; return 1 ;; esac
  ts="${payload##*\"ts\": }"; ts="${ts%\}}"
  ts=$((10#$ts))
  if ! [ "$((ts - 10#$now))" -le "$CONTROL_SKEW_S" ]; then CTRL_WHY=skew; return 1; fi
  if ! [ "$((10#$now - ts))" -le "$CONTROL_STALE_S" ]; then
    "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null; printf '%s\n' "$recv" >"$STATE_DIR/control_latch"
    CTRL_WHY=stale; return 1
  fi
  # Exact canonical modes (R10): keys strictly ascending bytewise (json.dumps sort_keys), so no key repeats, for ALL rooms.
  modes_part="${payload#*\"modes\": }"; modes_part="${modes_part%, \"ts\": *}"
  # The anchored regex above already proved the shape, so one split on "," (in a helper with its own IFS) is enough.
  rest="${modes_part#\{}"; rest="${rest%\}}"
  modes_keys_ascending "$rest" || { CTRL_WHY=unparseable; return 1; }
  CTRL_FLEET=on; CTRL_WHY=ok
  if [[ $GUARDIAN_ROOM =~ $CONTROL_ROOM_RE ]]; then
    modes_part="${payload#*\"modes\": }"; modes_part="${modes_part%, \"ts\": *}"
    pat="\"$GUARDIAN_ROOM\": "
    rest="${modes_part//"$pat"/}"
    cnt=$(( (${#modes_part} - ${#rest}) / ${#pat} ))
    if [ "$cnt" -gt 1 ]; then CTRL_FLEET=unreachable; CTRL_WHY=unparseable; return 1; fi
    case "$modes_part" in *"\"$GUARDIAN_ROOM\": \"heal\""*) CTRL_MODE=heal ;; esac
    # the consult hold (2.4 d'): clear only on the exact new form, this room's key once, with false
    if [ -n "$frag" ] && [[ $frag =~ $CONTROL_CONSULT_RE ]]; then
      rest="${frag#\{}"; rest="${rest%\}}"
      if modes_keys_ascending "$rest"; then
        rest="${frag//"$pat"/}"
        cnt=$(( (${#frag} - ${#rest}) / ${#pat} ))
        if [ "$cnt" -eq 1 ]; then case "$frag" in *"\"$GUARDIAN_ROOM\": false"*) CTRL_HOLD=clear ;; esac; fi
      fi
    fi
  fi
  return 0
}

# 2.4 d': 0 only when control is fresh and parses AND the consult hold is clear. Anything else (no control command, old form, kill, stale) is a hold.
consult_hold_clear() {
  [ -n "$GUARDIAN_CONTROL_SUB_CMD" ] || return 1
  control_parse || return 1
  [ "$CTRL_HOLD" = clear ]
}

# One audit line per state change (on <-> killed, or a new reason for being killed).
control_audit_change() {
  local f="$STATE_DIR/control_state" prev cur="$CTRL_FLEET:$CTRL_WHY"
  prev="$("$G_CAT" "$f" 2>/dev/null)"
  [ "$prev" = "$cur" ] && return 0
  printf '%s\n' "$cur" >"$f"
  audit "control state ${prev:-none} -> $cur age=${CTRL_AGE:-none}"
}

flag_fetch() {
  local out="$STATE_DIR/flags.fetch" now rc
  "$G_MKDIR" -p "$STATE_DIR" "$FLAG_DIR" 2>/dev/null
  now="$(now_epoch)"
  if [ "${G_RUNMODE:-}" = 1 ] && [ -z "$GUARDIAN_CONTROL_SUB_CMD" ]; then
    # run mode needs the control subscription; the old flag command is not used there (R12)
    CTRL_FLEET=unreachable; CTRL_MODE=shadow; CTRL_WHY=no_control_cmd; CTRL_AGE=""
    [ "${G_TREE_BAD:-}" = 1 ] && CTRL_WHY=tree
    [ "${G_CONF_BAD:-}" = 1 ] && CTRL_WHY=conf
    control_audit_change
    printf '%s\nfleet=unreachable\n' "$now" >"$FLAG_CACHE"; return 1
  fi
  if [ -n "$GUARDIAN_CONTROL_SUB_CMD" ]; then
    control_parse; rc=$?
    control_audit_change
    printf '%s\nfleet=%s\nmode=%s\n' "$now" "$CTRL_FLEET" "$CTRL_MODE" >"$FLAG_CACHE.tmp" && "$G_MV" "$FLAG_CACHE.tmp" "$FLAG_CACHE"
    return "$rc"
  fi
  if [ -z "$GUARDIAN_FLAG_CMD" ]; then
    printf '%s\nfleet=unreachable\n' "$now" >"$FLAG_CACHE"; return 1
  fi
  run_capped 5 "$out" g_conf_cmd "$GUARDIAN_FLAG_CMD" "$GUARDIAN_ROOM" "$GUARDIAN_CONTROL_TOPIC"
  rc=$?
  if [ "$rc" -ne 0 ] || ! "$G_GREP" -q '^fleet=' "$out" 2>/dev/null; then
    printf '%s\nfleet=unreachable\n' "$now" >"$FLAG_CACHE"; return 1
  fi
  { printf '%s\n' "$now"; "$G_GREP" -E '^(fleet|mode)=' "$out"; } >"$FLAG_CACHE"
  return 0
}

# 0 (true) when healing is blocked. Cheap: reads local files, so it is called before every action.
killswitch_engaged() {
  local fetched now fleet
  [ -e "$FLAG_DIR/heal-off" ] && return 0
  [ "${G_CONF_BAD:-}" = 1 ] && return 0
  [ -n "${G_BAD_CONST:-}" ] && return 0
  [ "${G_TREE_BAD:-}" = 1 ] && return 0
  [ "${G_RUNMODE:-}" = 1 ] && [ -z "$GUARDIAN_CONTROL_SUB_CMD" ] && return 0
  [ -r "$FLAG_CACHE" ] || return 0
  fetched="$("$G_SED" -n '1p' "$FLAG_CACHE")"
  now="$(now_epoch)"
  case "$fetched" in ""|*[!0-9]*) return 0 ;; esac
  [ "${#fetched}" -le 15 ] || return 0
  # With the control subscription the live file is re-read below on every call, so the cache age adds nothing there and would only
  # abort a long HEAL action (the 30 s tcc confirm wait outlasts FLAG_MAX_AGE_S=30 between two fetches). The old flag-command path keeps the age limit.
  if [ -z "$GUARDIAN_CONTROL_SUB_CMD" ]; then
    # old flag path (library tests only; run mode returned above)
    [ "$((10#$now - 10#$fetched))" -le "$FLAG_MAX_AGE_S" ] || return 0
  fi
  fleet="$("$G_SED" -n 's/^fleet=//p' "$FLAG_CACHE" | "$G_HEAD" -n1)"
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
  m="$("$G_SED" -n 's/^mode=//p' "$FLAG_CACHE" 2>/dev/null | "$G_HEAD" -n1)"
  [ "$m" = "heal" ] && echo heal || echo shadow
}

# Fetch at most once per FLAG_FETCH_S. The cache max age (FLAG_MAX_AGE_S) is longer, so one missed fetch is not yet OFF.
flag_poll() {
  local f="$STATE_DIR/flag_last" last now
  now="$(now_epoch)"; last="$("$G_CAT" "$f" 2>/dev/null)"
  case "$last" in ''|*[!0-9]*) last="" ;; esac
  [ "${#last}" -le 15 ] || last=""
  if [ -z "$last" ] || [ "$((10#$now - 10#$last))" -ge "$FLAG_FETCH_S" ]; then
    "$G_MKDIR" -p "$STATE_DIR" 2>/dev/null
    printf '%s\n' "$now" >"$f"
    flag_fetch
  fi
}
