#!/bin/bash
# Runs on the target as root. Arg: <extension id>. Removes only this extension's policy entries and files.
set -euo pipefail
ID="$1"
R="${ETA_TEST_ROOT:-}"
PLIST="$R/Library/Managed Preferences/com.google.Chrome.plist"
OWN=(-o root -g wheel); [ "$(id -u)" = 0 ] || OWN=()
PB=/usr/libexec/PlistBuddy
if [ -f "$PLIST" ]; then
  WORK="$(mktemp /tmp/eta-policy.XXXXXX)"; trap 'rm -f "$WORK"' EXIT
  cp "$PLIST" "$WORK"
  i=0
  while ENTRY="$("$PB" -c "Print :ExtensionInstallForcelist:$i" "$WORK" 2>/dev/null)"; do
    case "$ENTRY" in "$ID;"*) "$PB" -c "Delete :ExtensionInstallForcelist:$i" "$WORK"; continue;; esac
    i=$((i+1))
  done
  "$PB" -c "Print :ExtensionInstallForcelist:0" "$WORK" >/dev/null 2>&1 || "$PB" -c "Delete :ExtensionInstallForcelist" "$WORK" >/dev/null 2>&1 || true
  "$PB" -c "Delete :3rdparty:extensions:$ID" "$WORK" >/dev/null 2>&1 || true
  "$PB" -c "Print :3rdparty:extensions:" "$WORK" 2>/dev/null | grep -q "=" || "$PB" -c "Delete :3rdparty:extensions" "$WORK" >/dev/null 2>&1 || true
  "$PB" -c "Print :3rdparty" "$WORK" 2>/dev/null | grep -q "=" || "$PB" -c "Delete :3rdparty" "$WORK" >/dev/null 2>&1 || true
  if [ "$(plutil -convert json -o - "$WORK")" = "{}" ]; then rm -f "$PLIST"; else install -m 644 ${OWN[@]+"${OWN[@]}"} "$WORK" "$PLIST"; fi
fi
rm -rf "$R/Library/Application Support/eta-presence"
[ -n "$R" ] || killall cfprefsd 2>/dev/null || true
echo "removed policy entries and kit files for $ID"
