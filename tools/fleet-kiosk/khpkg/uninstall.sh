#!/bin/bash
# uninstall.sh — remove the eta-kiosk-health LaunchDaemon. Run with sudo. Idempotent.
#
#   sudo ./uninstall.sh            stop the daemon, remove plist + binary (config, spool and logs are kept)
#   sudo ./uninstall.sh --purge    also remove config, spool and the daemon's log files
#
# DESTDIR=/some/dir operates on a staged tree (no root, no launchctl) — used to verify this script.
set -euo pipefail

LABEL="com.evenscribe.kiosk-health"
DESTDIR="${DESTDIR:-}"
PURGE=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "uninstall.sh: unknown option $a" >&2; exit 1 ;;
  esac
done

if [ -z "$DESTDIR" ] && [ "$(id -u)" -ne 0 ]; then
  echo "uninstall.sh: run with sudo" >&2; exit 1
fi

PLIST="$DESTDIR/Library/LaunchDaemons/$LABEL.plist"
if [ -z "$DESTDIR" ]; then
  launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
  launchctl disable "system/$LABEL" >/dev/null 2>&1 || true
fi

rm -f "$PLIST"
rm -rf "$DESTDIR/usr/local/libexec/eta-kiosk-health"

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$DESTDIR/Library/Application Support/eta-kiosk-health"
  rm -rf "$DESTDIR/var/db/eta-kiosk-health"
  rm -f "$DESTDIR"/var/log/eta-kiosk-health.log "$DESTDIR"/var/log/eta-kiosk-health.log.[0-9] \
        "$DESTDIR"/var/log/eta-kiosk-health.out "$DESTDIR"/var/log/eta-kiosk-health.err
  echo "eta-kiosk-health removed (config, spool and logs purged)"
else
  echo "eta-kiosk-health removed (config, spool and logs kept; use --purge to delete them)"
fi
