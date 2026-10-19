#!/bin/zsh
# LaunchAgent entry. Invoked via /bin/zsh because a copy step may clear +x.
# Usage: ubus-launch.zsh serve|flush|verify [extra flags]
set -euo pipefail
ROOT="${UBUS_HOME:-/Users/vinaybhardwaj/dev/ubus}"
CONFIG="${UBUS_CONFIG:-$ROOT/config/ubus.json}"
NODE="${UBUS_NODE:-}"
if [[ -z "$NODE" ]]; then
  if [[ -x /opt/homebrew/bin/node ]]; then
    NODE=/opt/homebrew/bin/node
  elif [[ -x /usr/local/bin/node ]]; then
    NODE=/usr/local/bin/node
  else
    NODE="$(command -v node)"
  fi
fi
CMD="${1:-serve}"
shift || true
exec "$NODE" --disable-warning=ExperimentalWarning "$ROOT/dist/bin/ubus.js" "$CMD" --config "$CONFIG" "$@"
