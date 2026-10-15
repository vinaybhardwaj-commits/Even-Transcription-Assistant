#!/bin/bash
# install.sh — run ON THE KIOSK as root. Idempotent.
#   printf '%s\n' "$TOKEN" | sudo bash install.sh --machine-id EHRC-ECHOs-Mac-mini
# The ingest token is read from stdin (one line; prompted silently on a tty) and never echoed
# or put on argv. Test hook: INSTALL_ROOT=<dir> prefixes every destination, lifts the root check and
# SKIPS all launchctl calls (unless LAUNCHCTL=<stub binary> is also given).
set -euo pipefail

KNOWN_IDS="EHRC-AUDIOMETRYs-Mac-mini EHRC-CONSUL2s-Mac-mini-2 EHRC-CONSUL4s-Mac-mini EHRC-CONSUL4s-Mac-mini-2 EHRC-CONSUL5s-Mac-mini EHRC-CONSUL6s-Mac-mini EHRC-CONSUL7s-Mac-mini EHRC-DISCUSSIONs-Mac-mini EHRC-ECHOs-Mac-mini"
LABEL="com.eta.presence-guard"
R="${INSTALL_ROOT:-}"
LAUNCHCTL="${LAUNCHCTL:-}"
if [ -n "$R" ] && [ -z "$LAUNCHCTL" ]; then SKIP_LAUNCHCTL=1; else SKIP_LAUNCHCTL=0; LAUNCHCTL="${LAUNCHCTL:-launchctl}"; fi
ENV_DST="$R/usr/local/etc/eta-presence-guard.env"
SCRIPT_DST="$R/usr/local/libexec/eta-presence-guard.sh"
PLIST_DST="$R/Library/LaunchDaemons/${LABEL}.plist"
STATE_DIR="$R/var/db/eta-presence-guard"

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
is_root() { [ "$(id -u)" -eq 0 ]; }

MACHINE_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --machine-id) [ $# -ge 2 ] || die "--machine-id needs a value"; MACHINE_ID="$2"; shift 2 ;;
    --machine-id=*) MACHINE_ID="${1#*=}"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ -z "$R" ]; then is_root || die "must run as root"; fi
[ -n "$MACHINE_ID" ] || die "--machine-id <id> is required"
ok=0
for k in $KNOWN_IDS; do [ "$k" = "$MACHINE_ID" ] && ok=1; done
[ "$ok" -eq 1 ] || die "machine id not in the known list: $MACHINE_ID"

SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC/eta-presence-guard.sh" ] || die "missing $SRC/eta-presence-guard.sh"
[ -f "$SRC/${LABEL}.plist" ] || die "missing $SRC/${LABEL}.plist"

TOKEN=""
if [ -t 0 ]; then
  printf 'Ingest token (input hidden): ' >&2
  IFS= read -rs TOKEN || true
  printf '\n' >&2
else
  IFS= read -r TOKEN || true
fi
TOKEN=${TOKEN%$'\r'}
[ -n "$TOKEN" ] || die "ingest token must be supplied on stdin (one line)"
case "$TOKEN" in
  *[!A-Za-z0-9._~+/=:-]*) die "token contains unexpected characters" ;;
  *) ;;
esac

mkdir -p "$R/usr/local/etc" "$R/usr/local/libexec" "$R/Library/LaunchDaemons" "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Env file: write via a private temp file, then move into place.
TMP_ENV="$(mktemp "$R/usr/local/etc/.eta-presence-guard.env.XXXXXX")"
trap 'rm -f "$TMP_ENV"' EXIT
chmod 600 "$TMP_ENV"
printf 'MACHINE_ID=%s\nINGEST_TOKEN=%s\n' "$MACHINE_ID" "$TOKEN" > "$TMP_ENV"
if is_root; then chown root:wheel "$TMP_ENV"; fi
mv -f "$TMP_ENV" "$ENV_DST"
TOKEN=""

inst() { # inst <mode> <src> <dst>
  if is_root; then install -m "$1" -o root -g wheel "$2" "$3"; else install -m "$1" "$2" "$3"; fi
}
inst 0755 "$SRC/eta-presence-guard.sh" "$SCRIPT_DST"
inst 0644 "$SRC/${LABEL}.plist" "$PLIST_DST"
plutil -lint "$PLIST_DST" >/dev/null || die "installed plist failed plutil -lint"

# bootout is asynchronous: wait (max 10 s) until the service is gone before bootstrapping,
# then retry bootstrap (3 tries, 2 s apart). Failures must not trip set -e.
if [ "$SKIP_LAUNCHCTL" -eq 1 ]; then
  printf 'INSTALL_ROOT set: skipping launchctl\n' >&2
else
  "$LAUNCHCTL" bootout "system/${LABEL}" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    if ! "$LAUNCHCTL" print "system/${LABEL}" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  bootstrapped=0
  for attempt in 1 2 3; do
    if "$LAUNCHCTL" bootstrap system "$PLIST_DST"; then bootstrapped=1; break; fi
    if [ "$attempt" -lt 3 ]; then sleep 2; fi
  done
  [ "$bootstrapped" -eq 1 ] || die "launchctl bootstrap failed after 3 attempts"
fi

printf 'installed %s for %s (log: /var/log/eta-presence-guard.log, state: %s)\n' "$LABEL" "$MACHINE_ID" "$STATE_DIR"
