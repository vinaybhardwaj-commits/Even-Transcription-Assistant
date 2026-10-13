#!/bin/bash
# Remove the Kiosk Guardian from THIS Mac. Idempotent. Leaves nothing of the Guardian; never touches the recorder.
#   uninstall.sh [--dry-run] [--sudo "<cmd>"]
GUARDIAN_HOME="${GUARDIAN_HOME:-$HOME/Library/Application Support/EvenScribe/Guardian}"
LA_DIR="${LA_DIR:-$HOME/Library/LaunchAgents}"
GUARDIAN_ROOT_HELPER="${GUARDIAN_ROOT_HELPER:-/usr/local/libexec/eta-guardian-root}"
LABEL="com.evenscribe.room-guardian"
DRY=0; SUDO="sudo"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --sudo) SUDO="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$GUARDIAN_HOME" in */Guardian) ;; *) echo "refusing: GUARDIAN_HOME must end in /Guardian" >&2; exit 2 ;; esac
do_it() { if [ "$DRY" -eq 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then do_it launchctl bootout "gui/$(id -u)/$LABEL"; fi
[ -e "$LA_DIR/$LABEL.plist" ] && do_it rm -f "$LA_DIR/$LABEL.plist"
# our TCC.db backups sit beside TCC.db, outside the install dir: remove them through the root helper (before the helper goes)
# shellcheck disable=SC2086
if [ -e "$GUARDIAN_ROOT_HELPER" ]; then do_it $SUDO "$GUARDIAN_ROOT_HELPER" tcc-prune "$(id -un)" 0 >/dev/null; fi
[ -e "$GUARDIAN_HOME" ] && do_it rm -r "$GUARDIAN_HOME"
# shellcheck disable=SC2086
if [ -e "$GUARDIAN_ROOT_HELPER" ]; then do_it $SUDO rm -f "$GUARDIAN_ROOT_HELPER"; do_it $SUDO rmdir "$(dirname "$GUARDIAN_ROOT_HELPER")" 2>/dev/null; fi
echo "uninstalled (the audit log went with the install directory)"
