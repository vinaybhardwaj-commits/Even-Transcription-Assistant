#!/bin/bash
# Runs on the target as root. Args: <stage dir> <extension id> <crx name>. Older CRX files are removed after the new one is in place.
# Merges into /Library/Managed Preferences/com.google.Chrome.plist; other policies already there stay.
set -euo pipefail
STAGE="$1"; ID="$2"; CRX="$3"
# ETA_TEST_ROOT redirects every path for a non-root dry run.
R="${ETA_TEST_ROOT:-}"
DEST="$R/Library/Application Support/eta-presence"
MP="$R/Library/Managed Preferences"
PLIST="$MP/com.google.Chrome.plist"
OWN=(-o root -g wheel); [ "$(id -u)" = 0 ] || OWN=()
PB=/usr/libexec/PlistBuddy
URL="file:///Library/Application%20Support/eta-presence/update.xml"

install -d -m 755 ${OWN[@]+"${OWN[@]}"} "$DEST"
install -m 644 ${OWN[@]+"${OWN[@]}"} "$STAGE/$CRX" "$DEST/$CRX"
install -m 644 ${OWN[@]+"${OWN[@]}"} "$STAGE/update.xml" "$DEST/update.xml"
find "$DEST" -name "eta-pulse-presence-*.crx" ! -name "$CRX" -delete

# Work on a copy, then move it into place, so Chrome never reads a half-written policy file.
WORK="$(mktemp /tmp/eta-policy.XXXXXX)"; trap 'rm -f "$WORK"' EXIT
[ -f "$PLIST" ] && cp "$PLIST" "$WORK" || echo '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>' > "$WORK"

# ExtensionInstallForcelist: drop any old entry for this id, then append the current one.
"$PB" -c "Print :ExtensionInstallForcelist" "$WORK" >/dev/null 2>&1 || "$PB" -c "Add :ExtensionInstallForcelist array" "$WORK"
i=0
while ENTRY="$("$PB" -c "Print :ExtensionInstallForcelist:$i" "$WORK" 2>/dev/null)"; do
  case "$ENTRY" in "$ID;"*) "$PB" -c "Delete :ExtensionInstallForcelist:$i" "$WORK"; continue;; esac
  i=$((i+1))
done
"$PB" -c "Add :ExtensionInstallForcelist:0 string $ID;$URL" "$WORK"

# Config is baked into the package (manifest.eta_config), so no 3rdparty block. Drop any earlier one for
# this id (it held a copy of the token).
"$PB" -c "Delete :3rdparty:extensions:$ID" "$WORK" >/dev/null 2>&1 || true
plutil -lint "$WORK" >/dev/null

install -d -m 755 ${OWN[@]+"${OWN[@]}"} "$MP"
# 644 root:wheel is the normal mode for Managed Preferences; tighten to 600 only if Chrome still reads it.
install -m 644 ${OWN[@]+"${OWN[@]}"} "$WORK" "$PLIST"
[ -n "$R" ] || killall cfprefsd 2>/dev/null || true
echo "policy written: $PLIST (extension $ID, package $CRX)"
