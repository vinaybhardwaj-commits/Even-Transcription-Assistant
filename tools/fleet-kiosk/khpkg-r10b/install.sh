#!/bin/bash
# install.sh — install eta-kiosk-health as the root LaunchDaemon com.evenscribe.kiosk-health.
#
#   sudo ./install.sh [options]
#
# Idempotent: safe to re-run (binary and plist are replaced, config is kept unless --force-config).
# The bearer token is read from $KH_TOKEN or --token-file and is NEVER printed.
#
# Options (each also settable through the environment variable shown). A value given by flag OR environment is
# "explicit"; a value that is not explicit is never changed: --force-config keeps what config.json already holds
# (post, actions, token, ids, baseline, ...) and falls back to a default only on a first install.
#   --machine NAME          full hostname to report           (KH_MACHINE, default: `hostname`)
#   --room-id ID            room_xxx                          (KH_ROOM_ID)
#   --install-id ID         install_xxx                       (KH_INSTALL_ID)
#   --sink-url URL          server sink                       (KH_SINK_URL)
#   --token-file PATH       file holding the bearer token     (KH_TOKEN carries the token itself)
#   --post true|false       POST to the sink                  (KH_POST, first-install default false = spool only)
#   --console-user NAME     short name of the kiosk's user    (KH_CONSOLE_USER)
#   --watchdog on|off       DarkWake watchdog                 (KH_WATCHDOG, first-install default on)
#   --audio-ladder on|off   gated audio ladder                (KH_AUDIO_LADDER, first-install default off)
#   --reboot-rung on|off    allow the reboot rung             (KH_REBOOT_RUNG, first-install default off)
#   --binary PATH           binary to install                 (KH_BINARY, default ./build/kiosk-health)
#   --force-config          rewrite config.json (every key not given explicitly keeps its existing value)
#   --no-start              install files but do not (re)load the daemon
#
# Nothing on disk changes until everything has been validated: the flags, the new (or kept) config.json and the
# plist are all checked first, so a refused run leaves the old binary, config and plist exactly as they were.
#
# After installing, the EFFECTIVE configuration is read back from config.json and printed (never the token),
# so what is shown is what the daemon will run with, not what the flags said.
#
# Stray processes (R10): after launchd has booted the job out and before it is bootstrapped again, any process still running
# the installed binary is by definition not launchd's. It is stopped (SIGTERM, up to 5 s, then SIGKILL) and each pid is logged.
# Match is the exact installed binary path, so nothing else is touched.
#
# DESTDIR=/some/dir stages everything under that directory, skips chown and launchctl, and does not need
# root: used for dry-run verification of this script (Tests/install_test.sh).
set -euo pipefail

LABEL="com.evenscribe.kiosk-health"
# plutil is used for single-key reads (-extract) and plist -lint only. It must NOT be used to parse JSON as a
# whole: on macOS 15.8 `plutil -p` cannot read JSON at all. Whole-file JSON validation is the binary's
# --check-config.
PLUTIL="${PLUTIL:-/usr/bin/plutil}"
DESTDIR="${DESTDIR:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

LIBEXEC="$DESTDIR/usr/local/libexec/eta-kiosk-health"
CONF_DIR="$DESTDIR/Library/Application Support/eta-kiosk-health"
CONF="$CONF_DIR/config.json"
STATE_DIR="$DESTDIR/var/db/eta-kiosk-health"
SPOOL="$STATE_DIR/spool"
PLIST="$DESTDIR/Library/LaunchDaemons/$LABEL.plist"

# Empty = not given. Nothing here carries a default: defaults are applied only when there is no config to inherit.
MACHINE="${KH_MACHINE:-}"; ROOM_ID="${KH_ROOM_ID:-}"; INSTALL_ID="${KH_INSTALL_ID:-}"
SINK_URL="${KH_SINK_URL:-}"; POST="${KH_POST:-}"; CONSOLE_USER="${KH_CONSOLE_USER:-}"
WATCHDOG="${KH_WATCHDOG:-}"; LADDER="${KH_AUDIO_LADDER:-}"; REBOOT="${KH_REBOOT_RUNG:-}"
BINARY="${KH_BINARY:-$HERE/build/kiosk-health}"; TOKEN="${KH_TOKEN:-}"
FORCE_CONFIG=0; START=1

die() { echo "install.sh: $*" >&2; exit 1; }

# --- stray kiosk-health processes (R10/R10b) ----------------------------------------------------------------------------
# A stray is a process that runs the installed binary but is not launchd's. It is found by WHO HOLDS THE DAEMON LOCK
# (lsof -t <spool>/daemon.lock), whoever has the binary file open (lsof -t <binary>), plus every process whose ps name ends in
# "kiosk-health" (that is how a pre-lock orphan of a replaced binary shows),
# and each candidate is only signalled if its REAL executable path (lsof -a -p PID -d txt -Fn, first txt entry) equals the
# installed binary's real path. So `./kiosk-health`, a symlink and a renamed argv[0] are found, and a different program that
# merely sets argv[0] to the installed path (for example /bin/sleep) is left alone. lsof reports the original path even after
# the binary file was replaced by a newer one, so an old orphan is still recognised.
# The spool dir that holds the lock is spool_dir from the kept config.json, else the default under $STATE_DIR.
lock_file() {
  local d; d="$(existing spool_dir)"
  [ -n "$d" ] || d="$SPOOL"
  printf '%s/daemon.lock' "$d"
}
exec_path() { /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
stray_pids() {
  local real lock c
  real="$(cd "$LIBEXEC" 2>/dev/null && pwd -P)/kiosk-health"
  [ -f "$real" ] || return 0
  lock="$(lock_file)"
  { [ -f "$lock" ] && /usr/sbin/lsof -t "$lock" 2>/dev/null
    /usr/sbin/lsof -t "$real" 2>/dev/null   # whoever runs the current binary file, however it was started (relative, symlink, argv[0])
    ps -axo pid=,comm= 2>/dev/null | awk '{ pid = $1; $1 = ""; sub(/^ +/, ""); n = split($0, a, "/"); if (a[n] == "kiosk-health") print pid }'
  } 2>/dev/null | sort -un | while read -r c; do
    [ "$c" != "$$" ] && [ "$(exec_path "$c")" = "$real" ] && echo "$c"
  done
  return 0
}
# stop_strays: SIGTERM each, wait up to 5 s, SIGKILL what is left; one log line per pid and signal.
stop_strays() {
  local pids p i
  pids="$(stray_pids)"
  [ -n "$pids" ] || return 0
  for p in $pids; do echo "install.sh: stopping stray kiosk-health pid $p (not owned by launchd): SIGTERM"; kill -TERM "$p" 2>/dev/null || true; done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    pids="$(stray_pids)"
    [ -n "$pids" ] || return 0
    sleep 0.5
  done
  for p in $pids; do echo "install.sh: stray kiosk-health pid $p still running after 5 s: SIGKILL"; kill -KILL "$p" 2>/dev/null || true; done
  return 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --machine) MACHINE="$2"; shift 2 ;;
    --room-id) ROOM_ID="$2"; shift 2 ;;
    --install-id) INSTALL_ID="$2"; shift 2 ;;
    --sink-url) SINK_URL="$2"; shift 2 ;;
    --token-file) [ -r "$2" ] || die "cannot read token file $2"; TOKEN="$(tr -d '\r\n' < "$2")"; shift 2 ;;
    --post) POST="$2"; shift 2 ;;
    --console-user) CONSOLE_USER="$2"; shift 2 ;;
    --watchdog) WATCHDOG="$2"; shift 2 ;;
    --audio-ladder) LADDER="$2"; shift 2 ;;
    --reboot-rung) REBOOT="$2"; shift 2 ;;
    --binary) BINARY="$2"; shift 2 ;;
    --force-config) FORCE_CONFIG=1; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {print} /^set -euo/ {exit}' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

onoff() { case "$(echo "$1" | tr 'A-Z' 'a-z')" in on|true|1|yes) echo true ;; off|false|0|no) echo false ;; *) die "expected on|off, got '$1'" ;; esac; }
# Validate whatever was given now, so a typo fails before anything is touched.
for v in "$POST" "$WATCHDOG" "$LADDER" "$REBOOT"; do [ -z "$v" ] || onoff "$v" >/dev/null; done

if [ -z "$DESTDIR" ]; then
  [ "$(id -u)" -eq 0 ] || die "run with sudo (or set DESTDIR for a staged dry run)"
  [ "$(uname -m)" = "arm64" ] || die "this build targets Apple silicon (arm64) only"
fi
[ -x "$BINARY" ] || die "binary not found or not executable: $BINARY (run 'make build' first)"
"$BINARY" --version >/dev/null 2>&1 || die "binary does not run: $BINARY"
[ -f "$HERE/launchd/$LABEL.plist" ] || die "missing $HERE/launchd/$LABEL.plist"

json_str() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/}; s=${s//$'\t'/\\t}; printf '"%s"' "$s"; }
json_or_null() { if [ -n "$1" ]; then json_str "$1"; else printf 'null'; fi; }
# Value of a key in the CURRENT config.json ("" when the file or key is absent or null).
# JSON null reads back as "", whichever spelling plutil uses for it.
existing() {
  local v
  [ -f "$CONF" ] || return 0
  v="$("$PLUTIL" -extract "$1" raw -o - "$CONF" 2>/dev/null || true)"
  case "$v" in null|"<null>"|"(null)") v="" ;; esac
  printf '%s' "$v"
}

# Test hook (Tests/install_test.sh), honoured ONLY in a staged run (DESTDIR set): run just the stray step and exit.
if [ -n "$DESTDIR" ] && [ "${KH_TEST_ONLY_STOP_STRAYS:-}" = 1 ]; then stop_strays; exit 0; fi
# explicit-else-existing-else-default for a boolean: resolve_bool <explicit> <config key> <default>
resolve_bool() {
  if [ -n "$1" ]; then onoff "$1"; return; fi
  local ex; ex="$(existing "$2")"
  case "$ex" in true|false) echo "$ex" ;; *) echo "$3" ;; esac
}

# --- plan: resolve and validate EVERYTHING before touching the disk ------------------------------------
# Nothing below this block changes the machine until the config (new or kept) and the plist have passed
# validation, so a refused run leaves binary, config and plist exactly as they were.
PLAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kh-install.XXXXXX")"
trap 'rm -rf "$PLAN_DIR"' EXIT
"$PLUTIL" -lint "$HERE/launchd/$LABEL.plist" >/dev/null || die "plist failed plutil -lint: $HERE/launchd/$LABEL.plist"

# validate_config FILE LABEL: the binary being installed parses the file (types, required keys, no ladder_window,
# reboot rung implies ladder). Never `plutil -p`: it cannot read JSON on macOS 15.8.
validate_config() {
  local f=$1 what=$2 out
  out="$("$BINARY" --check-config "$f" 2>&1)" || die "$what is invalid ($out); nothing was changed"
}

NOTES=()
WRITE_CONFIG=0
if [ ! -f "$CONF" ] || [ "$FORCE_CONFIG" -eq 1 ]; then
  [ -n "$MACHINE" ] || MACHINE="$(existing machine)"
  [ -n "$MACHINE" ] || MACHINE="$(hostname)"
  [ -n "$SINK_URL" ] || SINK_URL="$(existing sink_url)"
  [ -n "$SINK_URL" ] || SINK_URL="https://www.evenscribe.app/api/kiosk-health"
  [ -n "$TOKEN" ] || TOKEN="$(existing token)"
  [ -n "$ROOM_ID" ] || ROOM_ID="$(existing room_id)"
  [ -n "$INSTALL_ID" ] || INSTALL_ID="$(existing install_id)"
  [ -n "$CONSOLE_USER" ] || CONSOLE_USER="$(existing console_user)"
  POST_B="$(resolve_bool "$POST" post false)"
  WATCHDOG_B="$(resolve_bool "$WATCHDOG" actions.darkwake_watchdog true)"
  LADDER_B="$(resolve_bool "$LADDER" actions.audio_ladder false)"
  REBOOT_B="$(resolve_bool "$REBOOT" actions.reboot_rung false)"
  if [ "$REBOOT_B" = true ] && [ "$LADDER_B" != true ]; then die "reboot_rung on requires audio_ladder on (resolved: ladder=$LADDER_B reboot=$REBOOT_B); nothing was changed"; fi
  BASELINE_JSON=""
  if [ -f "$CONF" ]; then BASELINE_JSON="$("$PLUTIL" -extract baseline json -o - "$CONF" 2>/dev/null || true)"; fi
  case "$BASELINE_JSON" in "{"*) ;; *) BASELINE_JSON='{"sleep": 0, "disksleep": 0, "displaysleep": 0, "SleepDisabled": 1, "autorestart": 1, "womp": 1}' ;; esac
  RECORDER_APP="$(existing recorder_app_path)"; SPOOL_DIR_CFG="$(existing spool_dir)"; LOG_PATH_CFG="$(existing log_path)"
  umask 077
  NEW_CONF="$PLAN_DIR/config.json"
  {
    printf '{\n'
    printf '  "machine": %s,\n' "$(json_str "$MACHINE")"
    printf '  "room_id": %s,\n' "$(json_or_null "$ROOM_ID")"
    printf '  "install_id": %s,\n' "$(json_or_null "$INSTALL_ID")"
    printf '  "sink_url": %s,\n' "$(json_str "$SINK_URL")"
    printf '  "token": %s,\n' "$(json_or_null "$TOKEN")"
    printf '  "post": %s,\n' "$POST_B"
    printf '  "baseline": %s,\n' "$BASELINE_JSON"
    printf '  "actions": {"darkwake_watchdog": %s, "audio_ladder": %s, "reboot_rung": %s},\n' "$WATCHDOG_B" "$LADDER_B" "$REBOOT_B"
    [ -z "$RECORDER_APP" ] || printf '  "recorder_app_path": %s,\n' "$(json_str "$RECORDER_APP")"
    [ -z "$SPOOL_DIR_CFG" ] || printf '  "spool_dir": %s,\n' "$(json_str "$SPOOL_DIR_CFG")"
    [ -z "$LOG_PATH_CFG" ] || printf '  "log_path": %s,\n' "$(json_str "$LOG_PATH_CFG")"
    printf '  "console_user": %s\n' "$(json_or_null "$CONSOLE_USER")"
    printf '}\n'
  } > "$NEW_CONF"
  validate_config "$NEW_CONF" "new config"
  WRITE_CONFIG=1
  CONFIG_NOTE="written"
else
  validate_config "$CONF" "existing config"
  CONFIG_NOTE="kept existing (use --force-config to rewrite)"
  # Flags given for a config that is being kept change nothing: say so rather than let the printout mislead.
  note_ignored() { # <flag> <explicit value> <existing value>
    if [ -n "$2" ] && [ "$2" != "$3" ]; then NOTES+=("$1 $2 ignored: config.json kept (it says '$3'); use --force-config to apply"); fi
  }
  [ -z "$POST" ] || note_ignored "--post" "$(onoff "$POST")" "$(existing post)"
  [ -z "$WATCHDOG" ] || note_ignored "--watchdog" "$(onoff "$WATCHDOG")" "$(existing actions.darkwake_watchdog)"
  [ -z "$LADDER" ] || note_ignored "--audio-ladder" "$(onoff "$LADDER")" "$(existing actions.audio_ladder)"
  [ -z "$REBOOT" ] || note_ignored "--reboot-rung" "$(onoff "$REBOOT")" "$(existing actions.reboot_rung)"
  note_ignored "--machine" "$MACHINE" "$(existing machine)"
  note_ignored "--room-id" "$ROOM_ID" "$(existing room_id)"
  note_ignored "--install-id" "$INSTALL_ID" "$(existing install_id)"
  note_ignored "--sink-url" "$SINK_URL" "$(existing sink_url)"
  note_ignored "--console-user" "$CONSOLE_USER" "$(existing console_user)"
  if [ -n "$TOKEN" ] && [ "$TOKEN" != "$(existing token)" ]; then NOTES+=("token given but ignored: config.json kept; use --force-config to apply"); fi
fi

# --- apply (everything validated) ------------------------------------------------------------------------
install -d -m 0755 "$LIBEXEC"
install -d -m 0755 "$DESTDIR/Library/LaunchDaemons"
install -d -m 0700 "$CONF_DIR"
install -d -m 0755 "$STATE_DIR"
install -d -m 0700 "$SPOOL"
if [ -z "$DESTDIR" ]; then
  chown root:wheel "$LIBEXEC" "$CONF_DIR" "$STATE_DIR" "$SPOOL"
fi

# binary (atomic replace)
install -m 0755 "$BINARY" "$LIBEXEC/.kiosk-health.new"
mv -f "$LIBEXEC/.kiosk-health.new" "$LIBEXEC/kiosk-health"
[ -z "$DESTDIR" ] && chown root:wheel "$LIBEXEC/kiosk-health"
if command -v codesign >/dev/null 2>&1; then
  codesign --force -s - "$LIBEXEC/kiosk-health" >/dev/null 2>&1 || echo "install.sh: warning: ad-hoc codesign failed (linker signature kept)" >&2
fi

# config (atomic replace, 0600)
if [ "$WRITE_CONFIG" -eq 1 ]; then
  install -m 0600 "$NEW_CONF" "$CONF_DIR/.config.$$.json"
  mv -f "$CONF_DIR/.config.$$.json" "$CONF"
  [ -z "$DESTDIR" ] && chown root:wheel "$CONF"
fi

# launchd plist
install -m 0644 "$HERE/launchd/$LABEL.plist" "$PLIST"
[ -z "$DESTDIR" ] && chown root:wheel "$PLIST"

# --- (re)load --------------------------------------------------------------------------------------
# A staged run (DESTDIR) never touches launchd. Tests set KH_TEST_LAUNCHCTL=<stub> together with DESTDIR to exercise this block.
if [ -z "$DESTDIR" ]; then LAUNCHCTL=launchctl; else LAUNCHCTL="${KH_TEST_LAUNCHCTL:-}"; fi
if [ -n "$LAUNCHCTL" ] && [ "$START" -eq 1 ]; then
  "$LAUNCHCTL" bootout "system/$LABEL" >/dev/null 2>&1 || true
  # bootout returns before launchd has finished unloading; bootstrapping into that window fails with
  # "Bootstrap failed: 5". Wait (max 10 s) until `launchctl print` no longer finds the service.
  waited=0; unloaded=1
  while "$LAUNCHCTL" print "system/$LABEL" >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -gt 20 ]; then unloaded=0; break; fi
    sleep 0.5
  done
  # R10b: if launchd still holds the job, whatever runs the binary may be launchd's own instance. Touch nothing.
  [ "$unloaded" = 1 ] || die "$LABEL is still loaded 10 s after bootout; not stopping any process (it could be launchd's own). The new binary, config and plist are in place; fix launchd (launchctl bootout system/$LABEL), then re-run install.sh"
  stop_strays   # launchd's job is gone, so anything still running the binary is not launchd's (e.g. an orphan started by hand)
  attempt=0
  until "$LAUNCHCTL" bootstrap system "$PLIST"; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 3 ] || die "launchctl bootstrap failed 3 times"
    sleep 2
  done
  "$LAUNCHCTL" enable "system/$LABEL"
  "$LAUNCHCTL" kickstart -k "system/$LABEL"
  LOAD_NOTE="loaded and started"
else
  LOAD_NOTE="not loaded (DESTDIR or --no-start)"
fi

show() { local v; v="$(existing "$1")"; if [ -n "$v" ]; then printf '%s' "$v"; else printf '(null)'; fi; }
TOKEN_STATE="not set"; [ -z "$(existing token)" ] || TOKEN_STATE="set"

echo "eta-kiosk-health installed"
echo "  binary : $LIBEXEC/kiosk-health"
echo "  config : $CONF ($CONFIG_NOTE)"
echo "  plist  : $PLIST"
echo "  spool  : $SPOOL"
echo "  daemon : $LOAD_NOTE"
echo "  effective config (read back from config.json):"
echo "    machine=$(show machine) room_id=$(show room_id) install_id=$(show install_id) console_user=$(show console_user)"
echo "    sink_url=$(show sink_url) post=$(show post)"
echo "    actions: darkwake_watchdog=$(show actions.darkwake_watchdog) audio_ladder=$(show actions.audio_ladder) reboot_rung=$(show actions.reboot_rung)"
echo "    token: $TOKEN_STATE (never printed)"
for n in "${NOTES[@]+"${NOTES[@]}"}"; do echo "  NOTE: $n"; done
