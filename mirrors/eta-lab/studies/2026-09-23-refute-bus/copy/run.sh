#!/bin/sh
# eta-bus-mcp launcher.
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/Users/vinaybhardwaj/.local/bin
exec /opt/homebrew/bin/node "$(dirname "$0")/server.mjs"
