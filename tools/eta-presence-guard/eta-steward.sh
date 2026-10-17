#!/bin/bash
# eta-steward.sh — Room Steward kiosk ticket executor. Runs as root from launchd every 60 s (com.eta.steward), separate from
# the presence guard so policy_cycle can stop the guard without stopping itself.
#
# Implements the Room Steward ticket contract v1 (ETA-STEWARD-TICKET-CONTRACT-06-OCT-2026). Each tick: GET
# <STEWARD_URL>?machine=<id> with the kiosk-health bearer; steward-verify (Swift; system openssl is LibreSSL: no Ed25519, and
# there is no python on kiosks) checks the envelope key_id and every ticket in the contract's order (malformed, bad_signature,
# expired, action_not_allowed, bad_params, machine_mismatch); replays (last 200 ticket_id/nonce) are rejected; the allow-listed
# action runs; a kiosk_health event kind steward.result reports done|failed|rejected|expired|unsupported.
# Trust anchor: the public key PEM shipped beside this script, pinned by sha256 below. No config or env can replace it
# (only STEWARD_TEST_MODE=1, which no production unit sets, lets tests point at another PEM/pin).
# Reads from kiosk-health's root-only config.json (plutil, key by key): machine, token, sink_url.
# The token is only ever in a shell variable and a curl config on stdin. Never reads Chrome Preferences/Cookies/Login Data.
#
# Env (tests): KH_CONFIG STATE_DIR PLIST_PATH HOME_ROOT NOW_OVERRIDE HID_IDLE_OVERRIDE CONSOLE_USER_OVERRIDE
#   STEWARD_RECORDER_LABEL STEWARD_EXT_VERSION POLL_SLEEP; with STEWARD_TEST_MODE=1 only: STEWARD_VERIFY_OVERRIDE STEWARD_URL_OVERRIDE
#   STEWARD_PEM_OVERRIDE STEWARD_PEM_SHA256
set -uo pipefail

EXT_ID="choegfgddhpljibnolbcljnlfhfpimbh"
KH_CONFIG="${KH_CONFIG:-/Library/Application Support/eta-kiosk-health/config.json}"
STATE_DIR="${STATE_DIR:-/var/db/eta-presence-guard}"
PLIST_PATH="${PLIST_PATH:-/Library/Managed Preferences/com.google.Chrome.plist}"
HOME_ROOT="${HOME_ROOT:-/Users}"
STEWARD_VERIFY="/usr/local/libexec/eta-presence-guard/steward-verify"
STEWARD_URL="https://www.evenscribe.app/api/steward/tickets"
STEWARD_EXT_VERSION="${STEWARD_EXT_VERSION:-0.1.1.39}"
STEWARD_RECORDER_LABEL="${STEWARD_RECORDER_LABEL:-}"
GUARD_LABEL="com.eta.presence-guard"
GUARD_PLIST="/Library/LaunchDaemons/com.eta.presence-guard.plist"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PULSE_URL="https://pulse.even.in/"
PEM_DEFAULT="/usr/local/libexec/eta-presence-guard/steward-public.pem.txt"
PEM_SHA256_PIN="21bd841f301e46cc03c2737ebdc59e09e98c60fa8c76efcc98583f38242c6c3c"
STEWARD_PEM="$PEM_DEFAULT"
if [ "${STEWARD_TEST_MODE:-}" = 1 ]; then STEWARD_VERIFY="${STEWARD_VERIFY_OVERRIDE:-$STEWARD_VERIFY}"; STEWARD_URL="${STEWARD_URL_OVERRIDE:-$STEWARD_URL}"; STEWARD_PEM="${STEWARD_PEM_OVERRIDE:-$PEM_DEFAULT}"; PEM_SHA256_PIN="${STEWARD_PEM_SHA256:-$PEM_SHA256_PIN}"; fi
DETAIL_MAX=2048
REPLAY_KEEP=200
IDLE_MIN=600

ts_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(TZ=Asia/Kolkata date +%Y-%m-%dT%H:%M:%S+05:30)" "$*"; }
is_uint() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
now_s() { if is_uint "${NOW_OVERRIDE:-}"; then printf '%s' "$NOW_OVERRIDE"; else date +%s; fi; }
now_ms() { printf '%s000' "$(now_s)"; }
ensure_state() { mkdir -p "$STATE_DIR" 2>/dev/null && chmod 700 "$STATE_DIR" 2>/dev/null; }

kh_get() { plutil -extract "$1" raw -o - "$KH_CONFIG" 2>/dev/null || true; }

# ---- result events ---------------------------------------------------------------------------------------------------------
clean() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.:=@ -' '_' | cut -c1-"${2:-120}"; }

boot_uuid() { sysctl -n kern.bootsessionuuid 2>/dev/null || printf 'unknown'; }

next_seq() {
  local f="$STATE_DIR/steward_seq" n
  n=$(cat "$f" 2>/dev/null) || n=0
  is_uint "$n" || n=0
  n=$((n + 1))
  printf '%s\n' "$n" > "$f" 2>/dev/null || true
  printf '%s' "$n"
}

# truncate_detail <text>: <= DETAIL_MAX bytes; cut text ends in "…". Details are built from [A-Za-z0-9_.:= @-] only (clean),
# so every byte is a character and any cut is on a character boundary.
truncate_detail() {
  local d="$1"
  if [ "${#d}" -gt "$DETAIL_MAX" ]; then d="$(printf '%s' "$d" | head -c $((DETAIL_MAX - 3)))…"; fi
  printf '%s' "$d"
}

# queue_result <ticket_id> <nonce> <outcome> <detail> [machine]: append one event line to the outbox (flushed by flush_outbox).
# machine = the ticket's machine (contract); own machine when the ticket had none.
queue_result() {
  local tid nonce outcome detail seq mach
  tid=$(clean "$1" 128); nonce=$(clean "$2" 128); outcome="$3"; detail=$(truncate_detail "$(clean "$4" 100000)")
  mach=$(clean "${5:--}" 128); case "$mach" in -|"") mach="$MACHINE" ;; esac
  seq=$(next_seq)
  printf '{"machine":"%s","boot_id":"steward-%s","seq":%s,"kind":"steward.result","ts":"%s","payload":{"ticket_id":"%s","nonce":"%s","outcome":"%s","detail":"%s"}}\n' \
    "$mach" "$(boot_uuid)" "$seq" "$(ts_utc)" "$tid" "$nonce" "$outcome" "$detail" >> "$STATE_DIR/steward_outbox.jsonl"
  log "result ticket=$tid action=${ACTION:-?} outcome=$outcome detail=$(clean "$4" 160)"
}

flush_outbox() {
  local f="$STATE_DIR/steward_outbox.jsonl" body code sink
  [ -s "$f" ] || return 0
  # cap: keep the newest 100 lines
  if [ "$(wc -l < "$f")" -gt 100 ]; then tail -n 100 "$f" > "$f.tmp" && mv -f "$f.tmp" "$f"; fi
  body=$(printf '{"events":[%s]}' "$(paste -sd, "$f")")
  sink="${SINK_URL:-https://www.evenscribe.app/api/kiosk-health}"
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$ETOKEN" |
    curl -sS -m 15 -o /dev/null -w '%{http_code}' -K - -X POST -H 'Content-Type: application/json' --data-binary "$body" "$sink" 2>/dev/null) || code=000
  case "$code" in
    2??) : > "$f"; log "post status=$code" ;;
    *) log "post status=${code:-000} (kept $(wc -l < "$f" | tr -d ' ') queued)" ;;
  esac
  return 0
}

# ---- replay store: one line "<ticket_id> <nonce>" per executed ticket, newest last, kept at REPLAY_KEEP --------------------
replayed() { [ -f "$STATE_DIR/steward_replay" ] && awk -v a="$1" -v b="$2" '$1==a || $2==b {f=1} END {exit !f}' "$STATE_DIR/steward_replay"; }
replay_record() {
  local f="$STATE_DIR/steward_replay"
  ( umask 077; printf '%s %s\n' "$1" "$2" >> "$f" )
  if [ "$(wc -l < "$f")" -gt "$REPLAY_KEEP" ]; then ( umask 077; tail -n "$REPLAY_KEEP" "$f" > "$f.tmp" ) && mv -f "$f.tmp" "$f"; fi
}

# ---- local safety ----------------------------------------------------------------------------------------------------------
console_user() {
  local u="${CONSOLE_USER_OVERRIDE:-}"
  if [ -z "$u" ]; then u=$(stat -f %Su /dev/console 2>/dev/null) || u=""; fi
  case "$u" in ''|root|loginwindow|_mbsetupuser|*[!A-Za-z0-9._-]*) return 1 ;; *) printf '%s' "$u" ;; esac
}

idle_gate() { # 0 when console HID idle >= IDLE_MIN; sets DETAIL on refusal
  local hid idle_s
  if is_uint "${HID_IDLE_OVERRIDE:-}"; then idle_s=$HID_IDLE_OVERRIDE
  else
    hid=$(ioreg -c IOHIDSystem 2>/dev/null | awk '/"HIDIdleTime"/ {print $NF; exit}')
    is_uint "$hid" || { DETAIL="idle_unknown"; return 1; }
    idle_s=$((hid / 1000000000))
  fi
  if [ "$idle_s" -lt "$IDLE_MIN" ]; then DETAIL="not_idle_${idle_s}s"; return 1; fi
  return 0
}

chrome_running() { pgrep -x "Google Chrome" >/dev/null 2>&1; }

# session_closed: 0 only when status.json says an explicit closed state AND no tape file changed in the last 2 min. Fail closed.
session_closed() {
  local dir="$HOME_ROOT/$CU/Library/Application Support/EvenScribe/RoomRecorder" st
  [ -f "$dir/status.json" ] || { DETAIL="session_unknown"; return 1; }
  st=$(plutil -extract state raw -o - "$dir/status.json" 2>/dev/null) || { DETAIL="session_unknown"; return 1; }
  case "$(printf '%s' "$st" | tr 'A-Z' 'a-z')" in idle|ready|stopped|closed|ended|none|inactive) ;; *) DETAIL="session_open"; return 1 ;; esac
  if [ -d "$dir/captures" ] && [ -n "$(find "$dir/captures" -type f -mmin -2 2>/dev/null | head -n 1)" ]; then DETAIL="session_open_tape_recent"; return 1; fi
  return 0
}

profile_ok() { # profile name of an existing directory in the console user's Chrome dir
  local p="$1"
  [ -n "$p" ] && [ "$p" != "-" ] || { DETAIL="profile_required"; return 1; }
  case "$p" in .*|*/*) DETAIL="bad_profile"; return 1 ;; *) ;; esac
  [ -d "$HOME_ROOT/$CU/Library/Application Support/Google/Chrome/$p" ] || { DETAIL="profile_not_found"; return 1; }
  return 0
}

chrome_stop() {
  local i=0
  pkill -TERM -x "Google Chrome" >/dev/null 2>&1 || true
  while [ "$i" -lt 15 ]; do chrome_running || return 0; sleep "${POLL_SLEEP:-1}"; i=$((i + 1)); done
  pkill -KILL -x "Google Chrome" >/dev/null 2>&1 || true
  sleep "${POLL_SLEEP:-1}"
  return 0
}

# Opens https://pulse.even.in/ in profile $1. Running Chrome: hand the request to it through the binary (never quits it).
# Not running: open -a with --args (starts Chrome on that profile).
chrome_open_profile() {
  local p="$1" lp w=0
  if chrome_running; then
    launchctl asuser "$CUID" sudo -u "$CU" "$CHROME_BIN" --profile-directory="$p" "$PULSE_URL" >/dev/null 2>&1 </dev/null &
    lp=$!
    while kill -0 "$lp" 2>/dev/null && [ "$w" -lt 10 ]; do sleep "${POLL_SLEEP:-1}"; w=$((w + 1)); done
  else
    launchctl asuser "$CUID" sudo -u "$CU" open -a "Google Chrome" --args "--profile-directory=$p" "$PULSE_URL" >/dev/null 2>&1 || return 1
  fi
  return 0
}

# ---- policy_cycle: the OPD 1 recipe (same as flip-0111.sh --repair, run locally) -------------------------------------------------
ASIDE=""
CYCLE_ACTIVE=0
cycle_restore() {
  [ "$CYCLE_ACTIVE" = 1 ] || return 0
  CYCLE_ACTIVE=0
  trap - EXIT HUP INT TERM
  if [ -f "$ASIDE" ]; then mkdir -p "$(dirname "$PLIST_PATH")" && mv -f "$ASIDE" "$PLIST_PATH"; fi
  killall cfprefsd >/dev/null 2>&1 || true
  sleep "${POLL_SLEEP:-1}"
  launchctl print "system/$GUARD_LABEL" >/dev/null 2>&1 || launchctl bootstrap system "$GUARD_PLIST" >/dev/null 2>&1 || true
  return 0
}

# Immediately before each Chrome kill: re-check the console idle time. When someone is at the machine, put everything back
# (plist, cfprefsd flush, guard bootstrapped), relaunch Chrome on the profile only if it is dead, and fail the ticket.
cycle_abort_if_active() { # $1 profile; returns 0 to go on, 1 after aborting (DETAIL set)
  idle_gate && return 0
  cycle_restore
  # Nothing new goes onto an in-use console: Chrome is relaunched only when it is not running, and then without the Pulse URL
  # (Chrome restores its own session).
  if ! chrome_running; then
    launchctl asuser "$CUID" sudo -u "$CU" open -a "Google Chrome" --args "--profile-directory=$1" >/dev/null 2>&1 || true
  fi
  DETAIL="console_active_midcycle"
  return 1
}

act_policy_cycle() { # $1 profile
  local p="$1" extd i
  extd="$HOME_ROOT/$CU/Library/Application Support/Google/Chrome/$p/Extensions/$EXT_ID"
  ASIDE="$STATE_DIR/com.google.Chrome.plist.steward-aside"
  CYCLE_ACTIVE=1
  trap 'cycle_restore; exit 130' HUP INT TERM
  trap cycle_restore EXIT
  [ -f "$ASIDE" ] && mv -f "$ASIDE" "$PLIST_PATH"          # crash recovery from an earlier run
  launchctl bootout "system/$GUARD_LABEL" >/dev/null 2>&1 || true
  if launchctl print "system/$GUARD_LABEL" >/dev/null 2>&1; then DETAIL="guard_still_loaded"; cycle_restore; return 1; fi
  if [ -f "$PLIST_PATH" ]; then mv -f "$PLIST_PATH" "$ASIDE" || { DETAIL="aside_failed"; cycle_restore; return 1; }; fi
  killall cfprefsd >/dev/null 2>&1 || true; sleep "${POLL_SLEEP:-1}"
  cycle_abort_if_active "$p" || return 1
  chrome_stop; chrome_open_profile "$p" || true
  i=0; while [ "$i" -lt 24 ]; do { [ ! -d "$extd" ] || [ -z "$(ls -A "$extd" 2>/dev/null | grep -v '^\.')" ]; } && break; sleep "${POLL_SLEEP:-1}"; i=$((i + 1)); done
  # restore the policy, flush, restart so Chrome installs fresh
  if [ -f "$ASIDE" ]; then mv -f "$ASIDE" "$PLIST_PATH" || { DETAIL="restore_failed"; cycle_restore; return 1; }; fi
  killall cfprefsd >/dev/null 2>&1 || true; sleep "${POLL_SLEEP:-1}"
  cycle_abort_if_active "$p" || return 1
  chrome_stop; chrome_open_profile "$p" || true
  i=0; while [ "$i" -lt 36 ]; do [ -d "$extd/${STEWARD_EXT_VERSION}_0" ] && break; sleep "${POLL_SLEEP:-1}"; i=$((i + 1)); done
  local ok=0; [ -d "$extd/${STEWARD_EXT_VERSION}_0" ] && ok=1
  cycle_restore
  if launchctl print "system/$GUARD_LABEL" >/dev/null 2>&1 && [ "$ok" = 1 ]; then DETAIL="installed_${STEWARD_EXT_VERSION}"; return 0; fi
  if [ "$ok" = 1 ]; then DETAIL="installed_guard_not_loaded"; else DETAIL="ext_dir_missing_after_cycle"; fi
  return 1
}

# Every tick: a policy_cycle that died without its trap (SIGKILL, jetsam) leaves the plist aside and the guard out.
recover_aside() {
  local a="$STATE_DIR/com.google.Chrome.plist.steward-aside"
  [ -f "$a" ] || return 0
  log "recover: aside plist found, restoring it and the guard"
  mkdir -p "$(dirname "$PLIST_PATH")" && mv -f "$a" "$PLIST_PATH" || { log "recover: restore failed"; return 0; }
  killall cfprefsd >/dev/null 2>&1 || true
  sleep "${POLL_SLEEP:-1}"
  launchctl print "system/$GUARD_LABEL" >/dev/null 2>&1 || launchctl bootstrap system "$GUARD_PLIST" >/dev/null 2>&1 || true
  return 0
}

# ---- actions ---------------------------------------------------------------------------------------------------------------
# run_action <action> <profile>: sets DETAIL; returns 0 ok, 1 failed, 2 refused
run_action() {
  local act="$1" prof="$2"
  DETAIL=""
  case "$act" in
    wake)
      caffeinate -u -t 5 >/dev/null 2>&1 && { DETAIL="caffeinate_u"; return 0; }
      DETAIL="caffeinate_failed"; return 1 ;;
    open_pulse|relaunch_chrome|policy_cycle)
      CU=$(console_user) || { DETAIL="no_console_user"; return 2; }
      CUID=$(id -u "$CU" 2>/dev/null) || { DETAIL="no_uid"; return 1; }
      idle_gate || return 2
      profile_ok "$prof" || return 2
      case "$act" in
        open_pulse) chrome_open_profile "$prof" && { DETAIL="opened_$(clean "$prof" 40)"; return 0; }; DETAIL="open_failed"; return 1 ;;
        relaunch_chrome) idle_gate || { DETAIL="console_active_midcycle"; return 2; }; chrome_stop; chrome_open_profile "$prof" && { DETAIL="relaunched_$(clean "$prof" 40)"; return 0; }; DETAIL="open_failed"; return 1 ;;
        policy_cycle) act_policy_cycle "$prof"; return $? ;;
      esac ;;
    restart_recorder_app)
      CU=$(console_user) || { DETAIL="no_console_user"; return 2; }
      CUID=$(id -u "$CU" 2>/dev/null) || { DETAIL="no_uid"; return 1; }
      session_closed || return 2
      [ -n "$STEWARD_RECORDER_LABEL" ] || { DETAIL="recorder_label_unset"; return 2; }
      launchctl kickstart -k "gui/$CUID/$STEWARD_RECORDER_LABEL" >/dev/null 2>&1 && { DETAIL="kickstart_gui"; return 0; }
      DETAIL="kickstart_failed"; return 1 ;;
    restart_kiosk_health)
      launchctl kickstart -k system/com.evenscribe.kiosk-health >/dev/null 2>&1 && { DETAIL="kickstart_system"; return 0; }
      DETAIL="kickstart_failed"; return 1 ;;
    *) DETAIL="action_not_allowed"; return 2 ;;
  esac
}

# ---- one ticket --------------------------------------------------------------------------------------------------------------
handle_ok() { # ticket_id nonce action profile_b64 expires_ms machine
  local tid="$1" nonce="$2" action="$3" pb64="$4" exp="$5" mach="$6" rc prof="-"
  ACTION="$action"
  if replayed "$tid" "$nonce"; then queue_result "$tid" "$nonce" rejected "replay" "$mach"; return 0; fi
  replay_record "$tid" "$nonce"   # recorded before anything runs: a ticket runs at most once
  if [ "$pb64" != "-" ]; then prof=$(printf '%s' "$pb64" | base64 -D 2>/dev/null) || prof="-"; fi
  if [ "$(now_ms)" -ge "$exp" ]; then queue_result "$tid" "$nonce" expired "expired_before_execution" "$mach"; return 0; fi
  run_action "$action" "$prof"; rc=$?
  case "$rc" in
    0) queue_result "$tid" "$nonce" done "$DETAIL" "$mach" ;;
    *) queue_result "$tid" "$nonce" failed "$DETAIL" "$mach" ;;
  esac
}

pem_pinned() { # 0 when the shipped PEM exists and its sha256 equals the pin
  local h
  [ -f "$STEWARD_PEM" ] || return 1
  h=$(shasum -a 256 "$STEWARD_PEM" 2>/dev/null | awk '{print $1}')
  [ "$h" = "$PEM_SHA256_PIN" ]
}

log_throttled() { # log_throttled <key> <message>: log when the message for <key> changes (or every 30th repeat)
  local f="$STATE_DIR/steward_log_$1" last c
  last=$(cat "$f" 2>/dev/null) || last=""
  if [ "$last" != "$2" ]; then log "$2"; printf '%s\n' "$2" > "$f" 2>/dev/null || true; fi
}

main() {
  local out body code line kind a b c d e f g
  ensure_state || true
  MACHINE="${MACHINE_OVERRIDE:-$(kh_get machine)}"
  CRED_VAL="$(kh_get token)"
  SINK_URL="$(kh_get sink_url)"
  if [ -z "$MACHINE" ] || [ -z "$CRED_VAL" ]; then
    c=$(cat "$STATE_DIR/steward_nc" 2>/dev/null) || c=0; is_uint "$c" || c=0; c=$((c + 1))
    if [ "$c" -ge 30 ]; then log "not_configured (needs machine and token in the kiosk-health config)"; c=0; fi
    printf '%s\n' "$c" > "$STATE_DIR/steward_nc" 2>/dev/null || true
    return 0
  fi
  case "$MACHINE" in *[!A-Za-z0-9._-]*) log "bad machine id in config"; return 0 ;; esac
  case "$CRED_VAL" in *$'\r'*|*$'\n'*) log "bad token in config (control character)"; return 0 ;; esac
  ETOKEN=${CRED_VAL//\\/\\\\}; ETOKEN=${ETOKEN//\"/\\\"}   # curl config line: escape \ and "
  recover_aside
  if ! pem_pinned; then log_throttled pem "trust anchor missing or sha256 mismatch: running no tickets ($STEWARD_PEM)"; return 0; fi
  flush_outbox
  out=$(printf 'header = "Authorization: Bearer %s"\n' "$ETOKEN" |
    curl -sS -m 15 -K - -w '\n%{http_code}' "$STEWARD_URL?machine=$MACHINE" 2>/dev/null) || out=$'\n000'
  code=${out##*$'\n'}; body=${out%$'\n'*}
  if [ "$code" != 200 ]; then log "poll status=$code"; return 0; fi
  out=$(printf '%s' "$body" | "$STEWARD_VERIFY" "$STEWARD_PEM" "$MACHINE" "$(now_ms)" 2>/dev/null) || { log "poll response unusable (verify helper failed)"; return 0; }
  while IFS=$'\t' read -r kind a b c d e f g; do
    case "$kind" in
      ENVBAD) log_throttled env "poll envelope refused: $a; processing nothing"; return 0 ;;
      ENV) rm -f "$STATE_DIR/steward_log_env" ;;
      OK) handle_ok "$a" "$b" "$c" "$d" "$e" "$f" ;;
      BAD) ACTION="?"; queue_result "$b" "$c" rejected "$a" "$d" ;;
      *) ;;
    esac
  done <<< "$out"
  flush_outbox
  return 0
}

[ "${STEWARD_SOURCE_ONLY:-}" = 1 ] && [ "${STEWARD_TEST_MODE:-}" = 1 ] && return 0 2>/dev/null
main "$@" || log "error rc=$?"
exit 0
