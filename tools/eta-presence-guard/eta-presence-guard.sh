#!/bin/bash
# eta-presence-guard.sh — re-assert the Chrome ExtensionInstallForcelist policy for the
# Pulse Presence extension. macOS wipes /Library/Managed Preferences at boot; this runs
# as root from launchd every 60 s and rewrites the managed plist when it is missing or
# stripped. Only writes: the managed plist (atomically), its own state dir, stdout (launchd log).
# Last resort: restart Chrome (SIGTERM -> SIGKILL -> open) when the extension is still missing.
#
# Flags / env (for tests):  --dry-run   PLIST_PATH  STATE_DIR  ENV_FILE  MACHINE_ID  PB
#   NO_KILL=1 (skip killall/curl/Chrome restart)   UPTIME_OVERRIDE=<s>   BOOTTIME_OVERRIDE=<kern.boottime text>
#   CONSOLE_USER_OVERRIDE  HOME_ROOT  HID_IDLE_OVERRIDE=<s>  BOOT_LOOP_SLEEP=<s, default 10>  QUIT_POLL=<s, default 1>
set -euo pipefail

EXT_ID="choegfgddhpljibnolbcljnlfhfpimbh"
KNOWN_IDS="EHRC-AUDIOMETRYs-Mac-mini EHRC-CONSUL2s-Mac-mini-2 EHRC-CONSUL4s-Mac-mini EHRC-CONSUL4s-Mac-mini-2 EHRC-CONSUL5s-Mac-mini EHRC-CONSUL6s-Mac-mini EHRC-CONSUL7s-Mac-mini EHRC-DISCUSSIONs-Mac-mini EHRC-ECHOs-Mac-mini"
FL_KEY=":ExtensionInstallForcelist"
BOOT_WINDOW=300        # seconds after boot during which the guard keeps re-checking
BOOT_LOOP_MAX=40       # hard cap on re-checks so the script always exits
REWRITE_MIN_AGE=180    # relaunch rung: last rewrite must be at least this old (s)

ENV_FILE="${ENV_FILE:-/usr/local/etc/eta-presence-guard.env}"
PLIST_PATH="${PLIST_PATH:-/Library/Managed Preferences/com.google.Chrome.plist}"
STATE_DIR="${STATE_DIR:-/var/db/eta-presence-guard}"
INGEST_URL="${INGEST_URL:-https://www.evenscribe.app/api/presence}"
HOME_ROOT="${HOME_ROOT:-/Users}"
PB="${PB:-/usr/libexec/PlistBuddy}"
NO_KILL="${NO_KILL:-0}"
BOOT_LOOP_SLEEP="${BOOT_LOOP_SLEEP:-10}"
QUIT_POLL="${QUIT_POLL:-1}"
MACHINE_ID="${MACHINE_ID:-}"
INGEST_TOKEN="${INGEST_TOKEN:-}"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ;;
  esac
done

ts_ist() { TZ=Asia/Kolkata date +%Y-%m-%dT%H:%M:%S+05:30; }
ts_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(ts_ist)" "$*"; }

is_uint() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
trim() { local s="$1"; s=${s#"${s%%[![:space:]]*}"}; s=${s%"${s##*[![:space:]]}"}; printf '%s' "$s"; }

ensure_state() { mkdir -p "$STATE_DIR" 2>/dev/null && chmod 700 "$STATE_DIR" 2>/dev/null; }

read_state() { # read_state <name> -> prints value or empty
  local v=""
  v=$(cat "$STATE_DIR/$1" 2>/dev/null) || v=""
  printf '%s' "$v"
}

load_env() {
  [ -r "$ENV_FILE" ] || return 0
  local line v
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      MACHINE_ID=*|INGEST_TOKEN=*)
        v=${line#*=}
        v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
        if [ "${line%%=*}" = "MACHINE_ID" ]; then MACHINE_ID=$v; else INGEST_TOKEN=$v; fi
        ;;
      *) ;;
    esac
  done < "$ENV_FILE"
  return 0
}

is_known() {
  local k
  for k in $KNOWN_IDS; do [ "$k" = "$1" ] && return 0; done
  return 1
}

# kern.boottime looks like: { sec = 1791154182, usec = 293731 } Mon Oct  5 ...
# Anchor on the leading "{ sec =" — an unanchored match would also hit "usec = ".
parse_boot_sec() { printf '%s\n' "$1" | sed -n 's/^{ sec = \([0-9][0-9]*\),.*/\1/p' | sed -n 1p; }

uptime_seconds() {
  if is_uint "${UPTIME_OVERRIDE:-}"; then printf '%s' "$UPTIME_OVERRIDE"; return 0; fi
  local bt boot now
  bt="${BOOTTIME_OVERRIDE:-}"
  if [ -z "$bt" ]; then bt=$(sysctl -n kern.boottime 2>/dev/null) || bt=""; fi
  boot=$(parse_boot_sec "$bt")
  now=$(date +%s)
  if is_uint "$boot"; then printf '%s' $((now - boot)); else printf '999999'; fi
}

# Prints the entries of the forcelist array in file $1, one per line (nothing if absent/unreadable).
existing_entries() {
  [ -n "${1:-}" ] && [ -f "$1" ] || return 0
  local out l
  out=$("$PB" -c "Print $FL_KEY" "$1" 2>/dev/null) || return 0
  while IFS= read -r l; do
    l=$(trim "$l")
    case "$l" in ''|'Array {'|'}') continue ;; *) ;; esac
    printf '%s\n' "$l"
  done <<< "$out"
  return 0
}

plist_has_entry() {
  [ -f "$PLIST_PATH" ] || return 1
  local l
  while IFS= read -r l; do
    if [ "$l" = "$E" ]; then return 0; fi
  done <<< "$(existing_entries "$PLIST_PATH")"
  return 1
}

# Atomic rewrite: build the new plist in a temp file beside the original, lint it, then mv -f.
# New forcelist = every existing entry whose extension id (text before ';') is not ours, then E.
# On any failure the original is left untouched and the temp file is removed.
do_write() {
  local dir tmp src="" entries l id n=0
  local -a cmds=()
  dir=$(dirname "$PLIST_PATH")
  mkdir -p "$dir" || return 1
  tmp="$dir/.eta-presence-guard.$$.tmp"
  rm -f "$tmp"
  if [ -e "$PLIST_PATH" ] && plutil -lint "$PLIST_PATH" >/dev/null 2>&1; then
    src="$PLIST_PATH"
    cp -p "$PLIST_PATH" "$tmp" || { rm -f "$tmp"; return 1; }
  fi
  entries=$(existing_entries "$src")
  if [ -n "$src" ] && "$PB" -c "Print $FL_KEY" "$tmp" >/dev/null 2>&1; then
    cmds+=(-c "Delete $FL_KEY")
  fi
  cmds+=(-c "Add $FL_KEY array")
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    id=${l%%;*}
    if [ "$id" = "$EXT_ID" ]; then continue; fi
    cmds+=(-c "Add $FL_KEY:$n string $l")
    n=$((n + 1))
  done <<< "$entries"
  cmds+=(-c "Add $FL_KEY:$n string $E")
  "$PB" "${cmds[@]}" "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
  plutil -lint "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
  if [ "$(id -u)" -eq 0 ]; then chown root:wheel "$tmp" || { rm -f "$tmp"; return 1; }; fi
  chmod 644 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$PLIST_PATH" || { rm -f "$tmp"; return 1; }
  if [ "$NO_KILL" != "1" ]; then killall cfprefsd >/dev/null 2>&1 || true; fi
  return 0
}

post_event() { # post_event <reason> [kind]
  local reason="$1" kind="${2:-}" body code esc kf=""
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  if [ "$NO_KILL" = "1" ]; then log "post status=skipped"; return 0; fi
  if [ -z "$INGEST_TOKEN" ]; then log "post status=no_token"; return 0; fi
  [ -z "$kind" ] || kf=$(printf ',"kind":"%s"' "$kind")
  body=$(printf '{"events":[{"source":"guard","machine":"%s","event":"guard","reason":"%s"%s,"ts":"%s"}]}' "$MACHINE_ID" "$reason" "$kf" "$(ts_utc)")
  esc=${INGEST_TOKEN//\\/\\\\}
  esc=${esc//\"/\\\"}
  code=""
  # Token travels over stdin as a curl config line (printf is a builtin: nothing on argv).
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$esc" |
    curl -sS -m 10 -o /dev/null -w '%{http_code}' -K - -X POST \
      -H 'Content-Type: application/json' --data-binary "$body" "$INGEST_URL" 2>/dev/null) || true
  log "post status=${code:-000}"
  return 0
}

# rewrite_failed posts are capped at FAILED_POST_CAP per boot so a persistently failing write
# cannot flood the sink (state file: "<boot sec> <count>").
FAILED_POST_CAP=3
failed_post_allowed() {
  local bt bid st sid cnt
  bt="${BOOTTIME_OVERRIDE:-}"
  if [ -z "$bt" ]; then bt=$(sysctl -n kern.boottime 2>/dev/null) || bt=""; fi
  bid=$(parse_boot_sec "$bt")
  [ -n "$bid" ] || bid=unknown
  st=$(read_state rewrite_failed_posts)
  sid=${st%% *}; cnt=${st#* }
  if [ "$sid" != "$bid" ] || ! is_uint "$cnt"; then cnt=0; fi
  if [ "$cnt" -ge "$FAILED_POST_CAP" ]; then return 1; fi
  if ensure_state; then printf '%s %s\n' "$bid" $((cnt + 1)) > "$STATE_DIR/rewrite_failed_posts" || true; fi
  return 0
}

# One decision + action pass. mode: first (counts ok runs for the 1-in-30 log) | loop (silent when ok).
# Sets RESULT = ok | rewrote | failed.
check_and_fix() {
  local mode="$1" up reason c
  RESULT=ok
  up=$(uptime_seconds)
  if [ ! -e "$PLIST_PATH" ]; then reason=missing
  elif ! plist_has_entry; then reason=stripped
  else reason=ok; fi
  if [ "$reason" != "ok" ] && [ "$up" -lt 180 ]; then reason=boot; fi

  if [ "$reason" = "ok" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log "dry-run decision=ok machine=$MACHINE_ID uptime=${up}s action=none (no write, no cfprefsd kill)"
    elif [ "$mode" = "first" ]; then
      c=$(read_state ok_count)
      is_uint "$c" || c=0
      c=$((c + 1))
      if [ "$c" -ge 30 ]; then log "ok"; c=0; fi
      if ensure_state; then printf '%s\n' "$c" > "$STATE_DIR/ok_count" || true; fi
    fi
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run decision=rewrite reason=$reason machine=$MACHINE_ID uptime=${up}s"
    log "dry-run action: atomic rewrite of \"$PLIST_PATH\" via temp file in same dir: PlistBuddy (one invocation) rebuilds $FL_KEY = existing entries not for $EXT_ID + '$E'; plutil -lint; chown root:wheel; chmod 644; mv -f; killall cfprefsd; write $STATE_DIR/last_rewrite; POST $INGEST_URL reason=$reason"
    return 0
  fi
  if do_write; then
    log "rewrite reason=$reason machine=$MACHINE_ID"
    if ensure_state; then date +%s > "$STATE_DIR/last_rewrite" || true; fi
    post_event "$reason"
    RESULT=rewrote
  else
    log "rewrite_failed reason=$reason machine=$MACHINE_ID"
    if failed_post_allowed; then
      post_event "rewrite_failed"
    else
      log "post status=suppressed (rewrite_failed cap ${FAILED_POST_CAP} per boot)"
    fi
    RESULT=failed
  fi
  return 0
}

# Boot race: launchd's RunAtLoad tick can run before macOS regenerates /Library/Managed Preferences
# (~7 s after boot) and wipe our file. While uptime < BOOT_WINDOW keep re-checking every
# BOOT_LOOP_SLEEP s; stop after 2 consecutive checks with our entry present, at uptime >= BOOT_WINDOW,
# or after BOOT_LOOP_MAX checks. Always terminates.
boot_loop() {
  local up consec=0 iter=0
  up=$(uptime_seconds)
  if [ "$up" -ge "$BOOT_WINDOW" ]; then return 0; fi
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run boot-loop: uptime=${up}s < ${BOOT_WINDOW}s -> would re-check every ${BOOT_LOOP_SLEEP}s until 2 consecutive ok checks or uptime ${BOOT_WINDOW}s (max ${BOOT_LOOP_MAX} checks)"
    return 0
  fi
  while [ "$iter" -lt "$BOOT_LOOP_MAX" ]; do
    sleep "$BOOT_LOOP_SLEEP"
    iter=$((iter + 1))
    check_and_fix loop
    if [ "$RESULT" = "ok" ]; then consec=$((consec + 1)); else consec=0; fi
    if [ "$consec" -ge 2 ]; then break; fi
    up=$(uptime_seconds)
    if [ "$up" -ge "$BOOT_WINDOW" ]; then break; fi
  done
  return 0
}

# Chrome's own Local State records which profiles are open (profile.last_active_profiles, else
# profile.last_used). Reads ONLY those two key paths via plutil — nothing else from that file is
# read or logged. Prints accepted profile directory names, one per line (nothing when the file is
# absent/unreadable/malformed or no named directory exists). Names containing "/" or equal to "",
# "." or ".." are rejected; names whose directory does not exist are dropped; duplicates removed.
# Never fails (every plutil call is failure-safe).
active_profiles() {
  local user="$1" base f i=0 n names="" acc=""
  base="$HOME_ROOT/$user/Library/Application Support/Google/Chrome"
  f="$base/Local State"
  [ -f "$f" ] || return 0
  while [ "$i" -lt 20 ]; do
    n=$(plutil -extract "profile.last_active_profiles.$i" raw -o - "$f" 2>/dev/null) || break
    names="$names$n"$'\n'
    i=$((i + 1))
  done
  acc=$(_accept_profiles "$base" "$names") || acc=""
  if [ -z "$acc" ]; then
    n=$(plutil -extract "profile.last_used" raw -o - "$f" 2>/dev/null) || n=""
    acc=$(_accept_profiles "$base" "$n"$'\n') || acc=""
  fi
  [ -z "$acc" ] || printf '%s\n' "$acc"
  return 0
}

# _accept_profiles <chrome base dir> <newline-separated names>: prints the accepted names, one per
# line, de-duplicated (newline-delimited match, so no character in a name can collide).
_accept_profiles() {
  local base="$1" n seen=$'\n'
  while IFS= read -r n; do
    case "$n" in ''|.|..|*/*) continue ;; *) ;; esac
    [ -d "$base/$n" ] || continue
    case "$seen" in *$'\n'"$n"$'\n'*) continue ;; *) ;; esac
    seen="$seen$n"$'\n'
    printf '%s\n' "$n"
  done <<< "$2"
  return 0
}

# True when profile directory $2 of console user $1 has the extension directory with >= 1 entry
# (a version subdir); dotfiles such as .DS_Store do not count.
profile_has_ext() {
  local d="$HOME_ROOT/$1/Library/Application Support/Google/Chrome/$2/Extensions/$EXT_ID" e
  [ -d "$d" ] || return 1
  # Glob, not ls: macOS ls implies -A for root, which would count .DS_Store. [!.]* skips dotfiles
  # whatever the uid; an unmatched glob stays literal and fails -e.
  for e in "$d"/[!.]*; do
    if [ -e "$e" ]; then return 0; fi
  done
  return 1
}

# Presence test for the relaunch rung. Sets RL_BASIS (active | fallback), RL_PROFILES (comma-joined
# profiles checked), RL_MISSING (first active profile lacking the extension) and, when present,
# RL_WHY (extension_present_active | extension_present). Returns 0 when the extension counts as present.
#  active   : Chrome reports open profiles -> present only if EVERY one of them has the extension.
#  fallback : no usable Local State -> present if ANY profile of the user has the extension dir.
ext_presence() {
  local user="$1" a p all_ok=1 base d
  local -a act=()
  RL_BASIS=""; RL_PROFILES=""; RL_MISSING=""
  a=$(active_profiles "$user") || a=""
  while IFS= read -r p; do
    [ -n "$p" ] && act+=("$p")
  done <<< "$a"
  if [ "${#act[@]}" -gt 0 ]; then
    RL_BASIS=active
    for p in "${act[@]}"; do
      RL_PROFILES="${RL_PROFILES:+$RL_PROFILES,}$p"
      if ! profile_has_ext "$user" "$p"; then
        all_ok=0
        [ -n "$RL_MISSING" ] || RL_MISSING="$p"
      fi
    done
    if [ "$all_ok" -eq 1 ]; then RL_WHY="extension_present_active"; return 0; fi
    return 1
  fi
  RL_BASIS=fallback
  base="$HOME_ROOT/$user/Library/Application Support/Google/Chrome"
  for d in "$base/"*/Extensions/"$EXT_ID"; do
    if [ -d "$d" ]; then
      p=${d#"$base/"}; p=${p%%/*}
      RL_PROFILES="${RL_PROFILES:+$RL_PROFILES,}$p"
    fi
  done
  if [ -n "$RL_PROFILES" ]; then RL_WHY="extension_present"; return 0; fi
  return 1
}

# Relaunch rung. Any hour (V, 5 Oct: allowed when the extension is missing after a rewrite and the
# console is idle > 10 min). "Missing" is judged on the profiles Chrome reports as open (see
# ext_presence), falling back to any-profile when Local State gives none.
# Sets RL_WHY (first failing condition), RL_USER, RL_REWRITE, RL_BASIS, RL_PROFILES, RL_MISSING.
# Returns 0 only when ALL conditions hold.
relaunch_eval() {
  RL_WHY=""; RL_USER=""; RL_REWRITE=""; RL_BASIS=""; RL_PROFILES=""; RL_MISSING=""
  local last_rewrite consumed last_relaunch now user hid idle_s
  now=$(date +%s)
  last_rewrite=$(read_state last_rewrite)
  if ! is_uint "$last_rewrite"; then RL_WHY="no_last_rewrite"; return 1; fi
  if [ $((now - last_rewrite)) -lt "$REWRITE_MIN_AGE" ]; then RL_WHY="last_rewrite_under_3min"; return 1; fi
  consumed=$(read_state last_relaunch_rewrite)
  if [ "$consumed" = "$last_rewrite" ]; then RL_WHY="already_relaunched_for_this_rewrite"; return 1; fi
  user="${CONSOLE_USER_OVERRIDE:-}"
  if [ -z "$user" ]; then user=$(stat -f %Su /dev/console 2>/dev/null) || user=""; fi
  case "$user" in ''|root|loginwindow) RL_WHY="no_console_user"; return 1 ;; *) ;; esac
  if ext_presence "$user"; then return 1; fi
  if is_uint "${HID_IDLE_OVERRIDE:-}"; then
    idle_s=$HID_IDLE_OVERRIDE
  else
    hid=$(ioreg -c IOHIDSystem 2>/dev/null) || hid=""
    hid=$(awk '/"HIDIdleTime"/ {print $NF; exit}' <<< "$hid")
    if ! is_uint "$hid"; then RL_WHY="idle_unknown"; return 1; fi
    idle_s=$((hid / 1000000000))
  fi
  if [ "$idle_s" -le 600 ]; then RL_WHY="not_idle_${idle_s}s"; return 1; fi
  last_relaunch=$(read_state last_relaunch)
  if is_uint "$last_relaunch" && [ $((now - last_relaunch)) -lt 1800 ]; then RL_WHY="relaunch_under_30min"; return 1; fi
  RL_USER=$user
  RL_REWRITE=$last_rewrite
  return 0
}

chrome_running() { pgrep -x "Google Chrome" >/dev/null 2>&1; }

wait_chrome_gone() { # wait_chrome_gone <polls>; poll every QUIT_POLL s; returns 0 once gone
  local i=0
  while [ "$i" -lt "$1" ]; do
    chrome_running || return 0
    sleep "$QUIT_POLL"
    i=$((i + 1))
  done
  chrome_running && return 1
  return 0
}

# Restart Chrome so it re-reads policy: SIGTERM (graceful quit, session restore keeps tabs), wait up to
# 15 polls, SIGKILL only if it is still running, then open as the console user. Chrome not running ->
# just open. No AppleScript automation: it can raise an Automation consent dialog on the kiosk screen.
restart_chrome() {
  local uid method=open
  uid=$(id -u "$RL_USER" 2>/dev/null) || uid=""
  if [ -z "$uid" ]; then log "relaunch_failed no_uid"; return 1; fi
  if chrome_running; then
    method=term
    pkill -TERM -x "Google Chrome" >/dev/null 2>&1 || true
    if ! wait_chrome_gone 15; then
      method=kill
      pkill -KILL -x "Google Chrome" >/dev/null 2>&1 || true
      wait_chrome_gone 5 || true
    fi
  fi
  launchctl asuser "$uid" sudo -u "$RL_USER" open -a "Google Chrome" "https://pulse.even.in/" >/dev/null 2>&1 \
    || log "relaunch_failed open"
  log "relaunch method=$method basis=${RL_BASIS:-none} profiles=${RL_PROFILES:-none} missing=${RL_MISSING:-none}"
  return 0
}

relaunch_do() {
  # Record the rewrite this relaunch consumed, so it fires at most once per rewrite.
  if ensure_state; then
    date +%s > "$STATE_DIR/last_relaunch" || true
    printf '%s\n' "$RL_REWRITE" > "$STATE_DIR/last_relaunch_rewrite" || true
  fi
  if [ "$NO_KILL" = "1" ]; then
    log "relaunch method=skipped basis=${RL_BASIS:-none} profiles=${RL_PROFILES:-none} missing=${RL_MISSING:-none}"
  else
    restart_chrome || true
  fi
  post_event "relaunch"
}

# Window rung. Chrome can stay up while the active profile has no window: the profile unloads and the
# extension stops. Fires when ALL hold: Chrome running, console idle > 600 s, and a profile Chrome
# reports as active has no open file under its directory (lsof on the Chrome pids; names only, no file
# is opened or read). Action: open https://pulse.even.in/ in that profile; Chrome is NOT quit.
# At most once per WINDOW_MIN_GAP s per profile. Reads nothing from inside a profile directory.
WINDOW_MIN_GAP=1800
WINDOW_LAUNCH_WAIT=10
chrome_pids() { pgrep -x "Google Chrome" 2>/dev/null | tr '\n' ',' | sed 's/,$//'; }

# profile_loaded <chrome base dir> <profile> <pids>: 0 when any Chrome pid holds an open file under the profile dir.
profile_loaded() {
  local base="$1" prof="$2" pids="$3" out
  # lsof exits 1 when any listed pid has gone but still prints the listing: keep the output whatever the rc.
  # No "p<pid>" line at all means lsof told us nothing: return 2 (unknown) and let the caller fail closed.
  out=$(lsof -nP -w -p "$pids" -Fn 2>/dev/null) || true
  case "$out" in p[0-9]*|*$'\n'p[0-9]*) ;; *) return 2 ;; esac
  case "$out" in *$'\n'"n$base/$prof/"*|"n$base/$prof/"*) return 0 ;; *) return 1 ;; esac
}

window_state_key() { printf 'window_open_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }

window_rung() {
  local user uid base pids hid idle_s prof last now key lp w plr
  now=$(date +%s)
  chrome_running || { [ "$DRY_RUN" != "1" ] || log "dry-run window: no (chrome_not_running)"; return 0; }
  user="${CONSOLE_USER_OVERRIDE:-}"
  if [ -z "$user" ]; then user=$(stat -f %Su /dev/console 2>/dev/null) || user=""; fi
  case "$user" in ''|root|loginwindow) return 0 ;; *) ;; esac
  if is_uint "${HID_IDLE_OVERRIDE:-}"; then
    idle_s=$HID_IDLE_OVERRIDE
  else
    hid=$(ioreg -c IOHIDSystem 2>/dev/null) || hid=""
    hid=$(awk '/"HIDIdleTime"/ {print $NF; exit}' <<< "$hid")
    is_uint "$hid" || return 0
    idle_s=$((hid / 1000000000))
  fi
  if [ "$idle_s" -le 600 ]; then
    [ "$DRY_RUN" != "1" ] || log "dry-run window: no (not_idle_${idle_s}s)"
    return 0
  fi
  pids=$(chrome_pids)
  [ -n "$pids" ] || return 0
  base="$HOME_ROOT/$user/Library/Application Support/Google/Chrome"
  while IFS= read -r prof; do
    [ -n "$prof" ] || continue
    plr=0; profile_loaded "$base" "$prof" "$pids" || plr=$?
    if [ "$plr" -eq 2 ]; then
      [ "$DRY_RUN" != "1" ] || log "dry-run window: no (lsof_unknown) profile=$prof"
      continue
    fi
    if [ "$plr" -eq 0 ]; then
      [ "$DRY_RUN" != "1" ] || log "dry-run window: no (profile_loaded) profile=$prof"
      continue
    fi
    key=$(window_state_key "$prof")
    last=$(read_state "$key")
    if is_uint "$last" && [ $((now - last)) -lt "$WINDOW_MIN_GAP" ]; then
      [ "$DRY_RUN" != "1" ] || log "dry-run window: no (window_open_under_30min) profile=$prof"
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then
      log "dry-run window: would open https://pulse.even.in/ in profile=$prof as $user (Chrome not quit)"
      continue
    fi
    if ensure_state; then printf '%s\n' "$now" > "$STATE_DIR/$key" || true; fi
    if [ "$NO_KILL" = "1" ]; then
      log "window_open method=skipped profile=$prof"
    else
      uid=$(id -u "$user" 2>/dev/null) || uid=""
      if [ -z "$uid" ]; then log "window_open_failed no_uid profile=$prof"; continue; fi
      # With Chrome running the binary hands the request to it and exits at once. Background it and
      # wait <= WINDOW_LAUNCH_WAIT s so a binary that stays up can never hold the tick.
      launchctl asuser "$uid" sudo -u "$user" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --profile-directory="$prof" "https://pulse.even.in/" >/dev/null 2>&1 </dev/null &
      lp=$!; w=0
      while kill -0 "$lp" 2>/dev/null && [ "$w" -lt "$WINDOW_LAUNCH_WAIT" ]; do sleep 1; w=$((w + 1)); done
      if kill -0 "$lp" 2>/dev/null; then log "window_open launch_still_running profile=$prof"; fi
      log "window_open method=launch profile=$prof"
    fi
    post_event "window_open" "window_open"
  done <<< "$(active_profiles "$user")"
  return 0
}

main() {
  load_env
  if [ -z "$MACHINE_ID" ]; then
    MACHINE_ID=$(scutil --get LocalHostName 2>/dev/null) || MACHINE_ID=""
  fi
  if ! is_known "$MACHINE_ID"; then
    log "unknown_host"
    return 0
  fi
  E="${EXT_ID};https://www.evenscribe.app/ext/${MACHINE_ID}/update.xml"

  check_and_fix first
  boot_loop

  # Relaunch rung (only ever acts when every gate passes).
  if relaunch_eval; then
    if [ "$DRY_RUN" = "1" ]; then
      log "dry-run relaunch: would restart Chrome as $RL_USER (SIGTERM, wait 15 s, SIGKILL if still running, then open https://pulse.even.in/) basis=${RL_BASIS:-none} profiles=${RL_PROFILES:-none} missing=${RL_MISSING:-none}"
    else
      relaunch_do
      RELAUNCHED=1
    fi
  elif [ "$DRY_RUN" = "1" ]; then
    log "dry-run relaunch: no ($RL_WHY) basis=${RL_BASIS:-none} profiles=${RL_PROFILES:-none}"
  fi
  # A relaunch in this tick leaves Chrome still starting: its profile is not loaded yet.
  [ "${RELAUNCHED:-0}" = "1" ] || window_rung || true
  return 0
}

# main runs inside an || list so that no unexpected failure can abort the tick half-way.
main "$@" || log "error rc=$?"
exit 0
