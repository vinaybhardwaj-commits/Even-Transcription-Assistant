#!/bin/sh
# even-jev-mcp launcher. Key file keeps the secret out of Claude Code config.
KEYFILE="$HOME/.config/even-jev/key"
if [ -z "$JEV_API_KEY" ] && [ -f "$KEYFILE" ]; then JEV_API_KEY="$(tr -d '[:space:]' < "$KEYFILE")"; export JEV_API_KEY; fi
exec /opt/homebrew/bin/node "$(dirname "$0")/dist/server.js"
