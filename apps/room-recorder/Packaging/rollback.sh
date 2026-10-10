#!/bin/sh
# rollback.sh — put an OLDER Room Recorder pkg on a room that has a NEWER one.   Run as root:
#
#   sudo sh rollback.sh /path/to/EvenScribe-Room-Recorder-<older>.pkg
#
# WHY A SCRIPT. `installer` skips the app bundle when a newer one is installed: pkgbuild marks the
# bundle version-checked by default, so `sudo installer -pkg <older>` over a newer app does nothing to
# the app. The newer bundle has to be gone first. This does the whole sequence, in an order that
# cannot leave the room without an app:
#
#   1. stop the recorder's LaunchAgent for the console user
#   2. remove the root helper daemon: bootout, delete its plist, delete its root-only helper copy
#   3. MOVE the app aside (not delete) and forget the pkg receipt
#   4. install the older pkg
#   5. on success delete the saved app and start the agent again; on failure put the saved app back
#
# The ETA_* overrides exist for the dry-run test and are honoured ONLY when ETA_ROLLBACK_TEST=1.

LABEL="com.evenscribe.room-recorder.helper"
AGENT_LABEL="com.evenscribe.room-recorder"
PKG_ID="com.evenscribe.room-recorder.pkg"

if [ "${ETA_ROLLBACK_TEST:-}" = "1" ]; then
  APP="${ETA_APP:?}"
  DAEMON_PLIST="${ETA_DAEMON_DIR:?}/$LABEL.plist"
  HELPER_COPY="${ETA_HELPER_DIR:?}/$LABEL"
  LAUNCHCTL="${ETA_LAUNCHCTL:?}"
  INSTALLER="${ETA_INSTALLER:?}"
  PKGUTIL="${ETA_PKGUTIL:?}"
  CONSOLE_UID="${ETA_CONSOLE_UID:-501}"
  AGENT_PLIST="${ETA_AGENT_PLIST:-}"
else
  [ "$(/usr/bin/id -u)" = "0" ] || { echo "rollback: run this as root (sudo)"; exit 1; }
  APP="/Applications/EvenScribe Room Recorder.app"
  DAEMON_PLIST="/Library/LaunchDaemons/$LABEL.plist"
  HELPER_COPY="/Library/PrivilegedHelperTools/$LABEL"
  LAUNCHCTL="/bin/launchctl"
  INSTALLER="/usr/sbin/installer"
  PKGUTIL="/usr/sbin/pkgutil"
  CONSOLE_UID="$(/usr/bin/stat -f %u /dev/console)"
  CONSOLE_HOME="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -nu "$CONSOLE_UID")" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
  AGENT_PLIST="$CONSOLE_HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
fi

OLDER_PKG="$1"
say() { echo "rollback: $*"; }

[ -n "$OLDER_PKG" ] && [ -f "$OLDER_PKG" ] || { say "usage: rollback.sh /path/to/older.pkg (file not found: ${OLDER_PKG:-none})"; exit 1; }
SAVED="$APP.rollback-saved"
[ ! -e "$SAVED" ] || { say "$SAVED already exists from an earlier attempt; look at it and remove it first"; exit 1; }

say "1/5 stopping the recorder agent for uid $CONSOLE_UID"
"$LAUNCHCTL" bootout "gui/$CONSOLE_UID/$AGENT_LABEL" > /dev/null 2>&1

say "2/5 removing the root helper daemon"
"$LAUNCHCTL" bootout "system/$LABEL" > /dev/null 2>&1
/bin/rm -f "$DAEMON_PLIST" "$HELPER_COPY"

say "3/5 moving the app aside and forgetting the receipt"
if [ -e "$APP" ]; then
  /bin/mv "$APP" "$SAVED" || { say "could not move $APP aside; nothing else was changed"; exit 1; }
fi
"$PKGUTIL" --forget "$PKG_ID" > /dev/null 2>&1

say "4/5 installing $OLDER_PKG"
if "$INSTALLER" -pkg "$OLDER_PKG" -target /; then
  say "5/5 done; removing the saved newer app"
  /bin/rm -rf "$SAVED"
  if [ -n "$AGENT_PLIST" ] && [ -f "$AGENT_PLIST" ]; then
    "$LAUNCHCTL" bootstrap "gui/$CONSOLE_UID" "$AGENT_PLIST" > /dev/null 2>&1
    say "recorder agent started again"
  else
    say "no LaunchAgent plist found; run install-launch-agent from the app (INSTALL.md step 4)"
  fi
  exit 0
fi

say "5/5 the older pkg FAILED to install; putting the newer app back"
/bin/rm -rf "$APP"
if [ -e "$SAVED" ]; then /bin/mv "$SAVED" "$APP"; fi
if [ -n "$AGENT_PLIST" ] && [ -f "$AGENT_PLIST" ]; then "$LAUNCHCTL" bootstrap "gui/$CONSOLE_UID" "$AGENT_PLIST" > /dev/null 2>&1; fi
say "the room is back on the newer app WITHOUT the root helper; reinstall the newer pkg to restore it"
exit 1
