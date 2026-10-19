#!/bin/sh
# Install the Mini LaunchAgent plists, substituting __UBUS_MINI_HOST__ from install/local.env.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
envfile="${UBUS_LOCAL_ENV:-$here/local.env}"
[ -f "$envfile" ] || { echo "refused: $envfile missing (copy local.env.example)" >&2; exit 1; }
UBUS_MINI_HOST="$(sed -n 's/^UBUS_MINI_HOST=//p' "$envfile" | tail -1)"
case "$UBUS_MINI_HOST" in
  ""|__UBUS_MINI_HOST__|*[!A-Za-z0-9._-]*) echo "refused: UBUS_MINI_HOST unset or invalid in $envfile" >&2; exit 1 ;;
esac
dest="${UBUS_LAUNCHAGENTS_DIR:-$HOME/Library/LaunchAgents}"
mkdir -p "$dest"
for p in uk.llmvinayminihome.ubus uk.llmvinayminihome.ubus-archive uk.llmvinayminihome.ubus-hub; do
  sed "s/__UBUS_MINI_HOST__/$UBUS_MINI_HOST/g" "$here/$p.plist" > "$dest/$p.plist"
  echo "installed $dest/$p.plist"
done
